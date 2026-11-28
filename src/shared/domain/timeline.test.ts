import { describe, expect, it } from "vitest";
import { applyCommands, CommandError } from "./commands";
import {
  DEFAULT_TRANSITION_MS,
  MAX_CLIPS_PER_COMMAND,
  MAX_TIMELINES_PER_PROJECT,
  MAX_TRACKS_PER_TIMELINE,
} from "./constants";
import { decodeMokaFile, encodeMokaFile } from "./codec";
import {
  createClipFromAsset,
  createTextClip,
  createTimeline,
  defaultTimelineTracks,
  nextTimelineName,
} from "./factories";
import { i18n } from "../i18n";
import {
  buildCutMokaFile,
  buildGoldenMokaFile,
  buildTimelineMokaFile,
  cutFixtureIds,
  timelineIds,
} from "./fixtures";
import { validateMokaFile, timelineAssetIds } from "./validate";
import type {
  DocumentCommand,
  MokaFile,
  ResourceEntry,
  TimelineClip,
} from "./types";

const NOW = "2026-01-01T00:00:00.000Z";

function apply(moka: MokaFile, ...commands: DocumentCommand[]) {
  return applyCommands(moka, commands);
}

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return (error as CommandError).code;
  }
  return "NO_ERROR";
}

/**
 * The round trip every command must survive: apply, undo with the inverse,
 * and the document is the one the step started from.
 */
function expectRoundTrip(
  moka: MokaFile,
  ...commands: DocumentCommand[]
): MokaFile {
  const { next, inverse } = apply(moka, ...commands);
  const undone = apply(next, ...inverse).next;
  expect(undone).toEqual(moka);
  return next;
}

function clipOf(
  moka: MokaFile,
  assetId: string,
  trackId: string,
  startMs: number,
) {
  const asset = findAssetEntry(moka, assetId);
  return createClipFromAsset(asset, trackId, startMs);
}

function findAssetEntry(moka: MokaFile, assetId: string): ResourceEntry {
  for (const list of Object.values(moka.resources)) {
    const found = list.find((entry) => entry.id === assetId);
    if (found) return found;
  }
  throw new Error(`fixture asset ${assetId} not found`);
}

function imageAsset(): ResourceEntry {
  return {
    id: "asset-image",
    name: "poster.png",
    path: "assets/images/poster-00000000.png",
    mime: "image/png",
    bytes: 2_048,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("the name a timeline is offered", () => {
  it("is spoken in the interface's own language, one past the count and any name taken", async () => {
    await i18n.changeLanguage("zh");
    try {
      const moka = buildGoldenMokaFile();
      expect(nextTimelineName(moka)).toBe("时间线 1");
      const taken = apply(moka, {
        type: "addTimeline",
        timeline: createTimeline("时间线 1"),
      }).next;
      expect(nextTimelineName(taken)).toBe("时间线 2");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

describe("timeline lifecycle commands", () => {
  it("is born at the frame it is asked for, and 1080p30 when asked for nothing", () => {
    expect(createTimeline("Cutting room").settings).toEqual({
      fps: 30,
      width: 1920,
      height: 1080,
      background: "#000000",
    });
    expect(
      createTimeline("Vertical", {
        fps: 60,
        width: 3840,
        height: 2160,
        background: "#000000",
      }).settings,
    ).toEqual({ fps: 60, width: 3840, height: 2160, background: "#000000" });
  });

  it("adds a timeline and takes it back out whole", () => {
    const moka = buildGoldenMokaFile();
    expect(moka.timelines).toBeUndefined();

    const timeline = createTimeline("Cutting room");
    const next = expectRoundTrip(moka, {
      type: "addTimeline",
      timeline,
    });
    expect(next.timelines).toHaveLength(1);
    expect(next.timelines![0].tracks.map((t) => t.name)).toEqual([
      "Video 1",
      "Audio 1",
      "Text 1",
    ]);
  });

  it("refuses a second timeline with the same id", () => {
    const moka = buildTimelineMokaFile();
    const timeline = createTimeline("One");
    const withOne = apply(moka, { type: "addTimeline", timeline }).next;
    const code = codeOf(() =>
      apply(withOne, { type: "addTimeline", timeline }),
    );
    expect(code).toBe("CONFLICT");
  });

  it("holds a project to its timeline count", () => {
    let moka = buildGoldenMokaFile();
    for (let i = 0; i < MAX_TIMELINES_PER_PROJECT; i += 1) {
      moka = apply(moka, {
        type: "addTimeline",
        timeline: createTimeline(`Timeline ${i + 1}`),
      }).next;
    }
    const code = codeOf(() =>
      apply(moka, {
        type: "addTimeline",
        timeline: createTimeline("One more"),
      }),
    );
    expect(code).toBe("VALIDATION_FAILED");
  });

  it("refuses a timeline that arrives with geometry, settings or seams it may not hold", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const asset = moka.resources.videos.find(
      (entry) => entry.id === ids.videoAsset,
    )!;

    const overlapping = createTimeline("Overlapping");
    const videoTrack = overlapping.tracks[0]!;
    overlapping.clips = [
      createClipFromAsset(asset, videoTrack.id, 0),
      createClipFromAsset(asset, videoTrack.id, 1_000),
    ];
    expect(
      codeOf(() => apply(moka, { type: "addTimeline", timeline: overlapping })),
    ).toBe("CLIP_OVERLAP");

    const badFrame = createTimeline("Bad frame", { fps: 29 });
    expect(
      codeOf(() => apply(moka, { type: "addTimeline", timeline: badFrame })),
    ).toBe("VALIDATION_FAILED");

    const tooMany = createTimeline("Too many");
    tooMany.tracks = Array.from(
      { length: MAX_TRACKS_PER_TIMELINE + 1 },
      (_, index) => ({
        ...tooMany.tracks[0]!,
        id: `track-${index}`,
        name: `Track ${index}`,
      }),
    );
    expect(
      codeOf(() => apply(moka, { type: "addTimeline", timeline: tooMany })),
    ).toBe("VALIDATION_FAILED");

    const doubled = createTimeline("Doubled");
    const trackId = doubled.tracks[0]!.id;
    const first = createClipFromAsset(asset, trackId, 0);
    const second = createClipFromAsset(asset, trackId, 4_000);
    doubled.clips = [first, second];
    doubled.transitions = [
      {
        id: "transition-1",
        afterClipId: first.id,
        kind: "crossfade",
        durationMs: 500,
        createdAt: NOW,
      },
      {
        id: "transition-2",
        afterClipId: first.id,
        kind: "crossfade",
        durationMs: 500,
        createdAt: NOW,
      },
    ];
    expect(
      codeOf(() => apply(moka, { type: "addTimeline", timeline: doubled })),
    ).toBe("CONFLICT");
  });

  it("renames a timeline and the undo gives the name back", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const next = expectRoundTrip(moka, {
      type: "renameTimeline",
      timelineId: ids.timeline,
      name: "Rough cut",
    });
    expect(next.timelines![0].name).toBe("Rough cut");
  });

  it("refuses an empty or overlong name", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    expect(
      codeOf(() =>
        apply(moka, {
          type: "renameTimeline",
          timelineId: ids.timeline,
          name: "",
        }),
      ),
    ).toBe("VALIDATION_FAILED");
    expect(
      codeOf(() =>
        apply(moka, {
          type: "renameTimeline",
          timelineId: ids.timeline,
          name: "x".repeat(81),
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("changes the frame only where asked and restores it", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const next = expectRoundTrip(moka, {
      type: "updateTimelineSettings",
      timelineId: ids.timeline,
      settings: { fps: 60 },
    });
    expect(next.timelines![0].settings).toEqual({
      fps: 60,
      width: 1920,
      height: 1080,
      background: "#000000",
    });
  });

  it("refuses a frame rate that is not one of the choices", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    expect(
      codeOf(() =>
        apply(moka, {
          type: "updateTimelineSettings",
          timelineId: ids.timeline,
          settings: { fps: 48 },
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("takes the last timeline out and the field goes with it", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const next = expectRoundTrip(moka, {
      type: "removeTimeline",
      timelineId: ids.timeline,
    });
    expect(next.timelines).toBeUndefined();
  });
});

describe("track commands", () => {
  it("adds a track at a place and takes it out again", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const track = {
      id: "track-overlay",
      kind: "video" as const,
      name: "Video 2",
      muted: false,
      hidden: false,
      locked: false,
      createdAt: NOW,
    };
    const next = expectRoundTrip(moka, {
      type: "addTrack",
      timelineId: ids.timeline,
      track,
      index: 0,
    });
    expect(next.timelines![0].tracks[0].id).toBe(track.id);
  });

  it("refuses a track that still holds clips", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const code = codeOf(() =>
      apply(moka, {
        type: "removeTrack",
        timelineId: ids.timeline,
        trackId: ids.videoTrack,
      }),
    );
    expect(code).toBe("TRACK_NOT_EMPTY");
  });

  it("mutes a track without touching its name, and the undo restores both", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const next = expectRoundTrip(moka, {
      type: "updateTrack",
      timelineId: ids.timeline,
      trackId: ids.audioTrack,
      patch: { muted: true },
    });
    const audio = next.timelines![0].tracks.find(
      (t) => t.id === ids.audioTrack,
    )!;
    expect(audio.muted).toBe(true);
    expect(audio.name).toBe("Audio 1");
  });

  it("locks a track and the undo unlocks it", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const next = expectRoundTrip(moka, {
      type: "updateTrack",
      timelineId: ids.timeline,
      trackId: ids.videoTrack,
      patch: { locked: true },
    });
    const video = next.timelines![0].tracks.find(
      (t) => t.id === ids.videoTrack,
    )!;
    expect(video.locked).toBe(true);
  });

  it("refuses every clip edit on a locked row, and still lets the row be unlocked", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const locked = apply(moka, {
      type: "updateTrack",
      timelineId: ids.timeline,
      trackId: ids.videoTrack,
      patch: { locked: true },
    }).next;
    const follower = clipOf(locked, ids.followerAsset, ids.videoTrack, 4_000);
    expect(
      codeOf(() =>
        apply(locked, {
          type: "addClips",
          timelineId: ids.timeline,
          clips: [follower],
        }),
      ),
    ).toBe("TRACK_LOCKED");
    expect(
      codeOf(() =>
        apply(locked, {
          type: "updateClips",
          timelineId: ids.timeline,
          patches: [{ clipId: ids.videoClip, patch: { volume: 0.5 } }],
        }),
      ),
    ).toBe("TRACK_LOCKED");
    expect(
      codeOf(() =>
        apply(locked, {
          type: "moveClips",
          timelineId: ids.timeline,
          moves: [{ clipId: ids.videoClip, startMs: 1_000 }],
        }),
      ),
    ).toBe("TRACK_LOCKED");
    expect(
      codeOf(() =>
        apply(locked, {
          type: "removeClips",
          timelineId: ids.timeline,
          clipIds: [ids.videoClip],
        }),
      ),
    ).toBe("TRACK_LOCKED");

    const unlocked = apply(locked, {
      type: "updateTrack",
      timelineId: ids.timeline,
      trackId: ids.videoTrack,
      patch: { locked: false },
    }).next;
    expect(
      unlocked.timelines![0].tracks.find((t) => t.id === ids.videoTrack)!
        .locked,
    ).toBe(false);
  });

  it("refuses a seam on a locked row and a move onto a locked row", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const paired = pairAt(moka, ids, 4_000);
    const locked = apply(paired, {
      type: "updateTrack",
      timelineId: ids.timeline,
      trackId: ids.videoTrack,
      patch: { locked: true },
    }).next;
    expect(
      codeOf(() =>
        apply(locked, {
          type: "addTransitions",
          timelineId: ids.timeline,
          transitions: [
            {
              id: "transition-locked",
              afterClipId: ids.videoClip,
              kind: "crossfade",
              durationMs: DEFAULT_TRANSITION_MS,
              createdAt: NOW,
            },
          ],
        }),
      ),
    ).toBe("TRACK_LOCKED");

    const withRow = apply(moka, {
      type: "addTrack",
      timelineId: ids.timeline,
      track: {
        id: "track-video-2",
        kind: "video",
        name: "Video 2",
        muted: false,
        hidden: false,
        locked: true,
        createdAt: NOW,
      },
    }).next;
    expect(
      codeOf(() =>
        apply(withRow, {
          type: "moveClips",
          timelineId: ids.timeline,
          moves: [
            {
              clipId: ids.videoClip,
              startMs: 8_000,
              trackId: "track-video-2",
            },
          ],
        }),
      ),
    ).toBe("TRACK_LOCKED");
  });
});

describe("clip commands", () => {
  it("lands a clip on its track and the undo clears the timeline to what it was", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const video = clipOf(moka, ids.followerAsset, ids.videoTrack, 8_000);
    const next = expectRoundTrip(moka, {
      type: "addClips",
      timelineId: ids.timeline,
      clips: [video],
    });
    expect(next.timelines![0].clips).toHaveLength(2);
  });

  it("refuses a clip that overlaps one already holding the place", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const overlapping = clipOf(moka, ids.followerAsset, ids.videoTrack, 2_000);
    const code = codeOf(() =>
      apply(moka, {
        type: "addClips",
        timelineId: ids.timeline,
        clips: [overlapping],
      }),
    );
    expect(code).toBe("CLIP_OVERLAP");
  });

  it("names the track and the clips in the overlap it refuses", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const overlapping = clipOf(moka, ids.followerAsset, ids.videoTrack, 2_000);
    try {
      apply(moka, {
        type: "addClips",
        timelineId: ids.timeline,
        clips: [overlapping],
      });
      throw new Error("expected an overlap");
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      const message = (error as CommandError).message;
      expect(message).toContain("Video 1");
      expect(message).toContain("opening.mp4");
    }
  });

  it("still refuses a new clip that an old overlap hides from the neighbour walk", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const held = moka.timelines![0].clips[0]!;
    moka.timelines![0].clips.push({
      ...held,
      id: "clip-held-short",
      label: "held.mp4",
      startMs: 2_000,
      durationMs: 500,
      outPointMs: 500,
    });
    const hidden = {
      ...held,
      id: "clip-new-hidden",
      label: "new.mp4",
      startMs: 3_500,
      durationMs: 300,
      outPointMs: 300,
    };
    const code = codeOf(() =>
      apply(moka, {
        type: "addClips",
        timelineId: ids.timeline,
        clips: [hidden],
      }),
    );
    expect(code).toBe("CLIP_OVERLAP");
  });

  it("still lands a clip when another track already carries an overlap", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const held = moka.timelines![0].clips[0]!;
    moka.timelines![0].clips.push({
      ...held,
      id: "clip-held-overlap",
      label: "held.mp4",
      startMs: 2_000,
    });
    const caption = createTextClip("Caption", ids.textTrack, 0, 1_000);
    const next = apply(moka, {
      type: "addClips",
      timelineId: ids.timeline,
      clips: [caption],
    }).next;
    expect(next.timelines![0].clips).toContainEqual(caption);
  });

  it("lets two clips touch end to start, which a seam may want", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const beside = clipOf(moka, ids.followerAsset, ids.videoTrack, 4_000);
    const next = apply(moka, {
      type: "addClips",
      timelineId: ids.timeline,
      clips: [beside],
    }).next;
    expect(next.timelines![0].clips).toHaveLength(2);
  });

  it("refuses a clip whose kind does not match the track's", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const misplaced = clipOf(moka, ids.videoAsset, ids.audioTrack, 8_000);
    const code = codeOf(() =>
      apply(moka, {
        type: "addClips",
        timelineId: ids.timeline,
        clips: [misplaced],
      }),
    );
    expect(code).toBe("VALIDATION_FAILED");
  });

  it("refuses a clip whose duration disagrees with its window over its speed", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const broken = {
      ...clipOf(moka, ids.videoAsset, ids.videoTrack, 8_000),
      durationMs: 3_000,
    };
    const code = codeOf(() =>
      apply(moka, {
        type: "addClips",
        timelineId: ids.timeline,
        clips: [broken],
      }),
    );
    expect(code).toBe("VALIDATION_FAILED");
  });

  it("refuses a window past the end of its file, but leaves an old one's other fields editable", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const past = {
      ...clipOf(moka, ids.videoAsset, ids.videoTrack, 8_000),
      durationMs: 5_000,
      outPointMs: 5_000,
    };
    expect(
      codeOf(() =>
        apply(moka, {
          type: "addClips",
          timelineId: ids.timeline,
          clips: [past],
        }),
      ),
    ).toBe("VALIDATION_FAILED");

    const legacy = buildTimelineMokaFile();
    const held = legacy.timelines![0].clips[0]!;
    held.durationMs = 5_000;
    held.outPointMs = 5_000;
    expect(
      codeOf(() =>
        apply(legacy, {
          type: "updateClips",
          timelineId: ids.timeline,
          patches: [{ clipId: held.id, patch: { volume: 0.5 } }],
        }),
      ),
    ).toBe("NO_ERROR");
    expect(
      codeOf(() =>
        apply(legacy, {
          type: "updateClips",
          timelineId: ids.timeline,
          patches: [
            {
              clipId: held.id,
              patch: { durationMs: 4_500, outPointMs: 4_500 },
            },
          ],
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("refuses a material clip that names no asset and a text clip that carries none", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const assetless = clipOf(moka, ids.followerAsset, ids.videoTrack, 10_000);
    delete assetless.assetId;
    expect(
      codeOf(() =>
        apply(moka, {
          type: "addClips",
          timelineId: ids.timeline,
          clips: [assetless],
        }),
      ),
    ).toBe("VALIDATION_FAILED");

    const wordless = createTextClip("Hello", ids.textTrack, 0);
    delete (wordless as { text?: unknown }).text;
    expect(
      codeOf(() =>
        apply(moka, {
          type: "addClips",
          timelineId: ids.timeline,
          clips: [wordless],
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("reads an image clip for its own duration and refuses a window on it", () => {
    const moka = buildCutMokaFile();
    const ids = cutFixtureIds();
    const asset = moka.resources.images.find(
      (entry) => entry.id === ids.imageAsset,
    )!;
    const still = createClipFromAsset(asset, ids.videoTrack, 9_500);
    expect(still.durationMs).toBe(4_000);
    const next = apply(moka, {
      type: "addClips",
      timelineId: ids.timeline,
      clips: [still],
    }).next;
    expect(next.timelines![0].clips).toHaveLength(5);

    const trimmed = { ...still, inPointMs: 100 };
    expect(
      codeOf(() =>
        apply(moka, {
          type: "addClips",
          timelineId: ids.timeline,
          clips: [trimmed],
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("moves a clip in time and the undo puts it back", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const next = expectRoundTrip(moka, {
      type: "moveClips",
      timelineId: ids.timeline,
      moves: [{ clipId: ids.videoClip, startMs: 9_000 }],
    });
    expect(
      next.timelines![0].clips.find((c) => c.id === ids.videoClip)!.startMs,
    ).toBe(9_000);
  });

  it("moves a clip onto another track of its kind and the undo returns it", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const withRow = apply(moka, {
      type: "addTrack",
      timelineId: ids.timeline,
      track: {
        id: "track-text-2",
        kind: "text" as const,
        name: "Text 2",
        muted: false,
        hidden: false,
        locked: false,
        createdAt: NOW,
      },
    }).next;
    const caption = createTextClip("Caption", ids.textTrack, 0);
    const withClip = apply(withRow, {
      type: "addClips",
      timelineId: ids.timeline,
      clips: [caption],
    }).next;
    const next = expectRoundTrip(withClip, {
      type: "moveClips",
      timelineId: ids.timeline,
      moves: [{ clipId: caption.id, startMs: 500, trackId: "track-text-2" }],
    });
    const moved = next.timelines![0].clips.find((c) => c.id === caption.id)!;
    expect(moved.trackId).toBe("track-text-2");
    expect(moved.startMs).toBe(500);
  });

  it("refuses a move onto a held place", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    // A second clip holds 8000–11000; moving the first onto it is refused.
    const second = clipOf(moka, ids.followerAsset, ids.videoTrack, 8_000);
    const withTwo = apply(moka, {
      type: "addClips",
      timelineId: ids.timeline,
      clips: [second],
    }).next;
    const code = codeOf(() =>
      apply(withTwo, {
        type: "moveClips",
        timelineId: ids.timeline,
        moves: [{ clipId: ids.videoClip, startMs: 6_000 }],
      }),
    );
    expect(code).toBe("CLIP_OVERLAP");
  });

  it("refuses a bare overlap the width of a seam", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const withSecond = pairAt(moka, ids, 4_000);
    const second = clipAfter(withSecond, ids.videoClip)!;
    // With no transition on the seam, the same pull-back two clips would
    // take under one is a plain overlap and nothing exempts it.
    const code = codeOf(() =>
      apply(withSecond, {
        type: "moveClips",
        timelineId: ids.timeline,
        moves: [{ clipId: second.id, startMs: 4_000 - DEFAULT_TRANSITION_MS }],
      }),
    );
    expect(code).toBe("CLIP_OVERLAP");
  });

  it("patches a clip's volume without touching its text, and undoes exactly that", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const next = expectRoundTrip(moka, {
      type: "updateClips",
      timelineId: ids.timeline,
      patches: [{ clipId: ids.videoClip, patch: { volume: 0.5 } }],
    });
    const clip = next.timelines![0].clips.find((c) => c.id === ids.videoClip)!;
    expect(clip.volume).toBe(0.5);
    expect(clip.speed).toBe(1);
  });

  it("clears an adjust and the undo puts it back", () => {
    const moka = buildCutMokaFile();
    const ids = cutFixtureIds();
    const cleared = apply(moka, {
      type: "updateClips",
      timelineId: ids.timeline,
      patches: [{ clipId: ids.clipA, patch: { adjust: null } }],
    });
    const bare = cleared.next.timelines![0].clips.find(
      (clip) => clip.id === ids.clipA,
    )!;
    expect(bare.adjust).toBeUndefined();
    const undone = apply(cleared.next, ...cleared.inverse).next;
    expect(undone).toEqual(moka);
  });

  it("brings a filter in and the undo takes it back out", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const clip = moka.timelines![0].clips[0];
    expect(clip.filter).toBeUndefined();
    const next = expectRoundTrip(moka, {
      type: "updateClips",
      timelineId: ids.timeline,
      patches: [{ clipId: ids.videoClip, patch: { filter: "cool" } }],
    });
    expect(
      next.timelines![0].clips.find((c) => c.id === ids.videoClip)!.filter,
    ).toBe("cool");
  });

  it("refuses a patch that stretches a clip onto its neighbour", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    // Put a second clip right behind the first, then stretch the first onto it.
    const second = clipOf(moka, ids.followerAsset, ids.videoTrack, 4_000);
    const withTwo = apply(moka, {
      type: "addClips",
      timelineId: ids.timeline,
      clips: [second],
    }).next;
    const code = codeOf(() =>
      apply(withTwo, {
        type: "updateClips",
        timelineId: ids.timeline,
        patches: [
          {
            clipId: ids.videoClip,
            patch: { durationMs: 6_000, outPointMs: 6_000 },
          },
        ],
      }),
    );
    expect(code).toBe("CLIP_OVERLAP");
  });

  it("removes a clip and both seams it touched, and the undo restores all three", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const next = expectRoundTrip(moka, {
      type: "removeClips",
      timelineId: ids.timeline,
      clipIds: [ids.videoClip],
    });
    expect(next.timelines![0].clips).toHaveLength(0);
    expect(next.timelines![0].transitions).toHaveLength(0);
  });

  it("reads a frame-aligned split of a sped clip as two honest sides", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    // One clip reading three seconds of material at 1.5×: two seconds on the
    // timeline, and each half of a split must state its own window honestly.
    const sped: TimelineClip = {
      ...moka.timelines![0].clips[0],
      speed: 1.5,
      durationMs: 2_000,
      inPointMs: 0,
      outPointMs: 3_000,
    };
    const cut = apply(moka, {
      type: "updateClips",
      timelineId: ids.timeline,
      patches: [
        {
          clipId: ids.videoClip,
          patch: { speed: 1.5, durationMs: 2_000, outPointMs: 3_000 },
        },
      ],
    }).next;

    // The split the room assembles: shorten the left half, land the right one
    // behind it, each side rounding its own run of material to the millisecond.
    const p = 999;
    const right: TimelineClip = {
      ...sped,
      id: "clip-cut-right",
      startMs: p,
      durationMs: 2_000 - p,
      inPointMs: 3_000 - Math.round((2_000 - p) * 1.5),
      outPointMs: 3_000,
    };
    const next = expectRoundTrip(
      cut,
      {
        type: "updateClips",
        timelineId: ids.timeline,
        patches: [
          {
            clipId: ids.videoClip,
            patch: {
              durationMs: p,
              outPointMs: Math.round(p * 1.5),
            },
          },
        ],
      },
      { type: "addClips", timelineId: ids.timeline, clips: [right] },
    );

    const clips = next.timelines![0].clips;
    const left = clips.find((clip) => clip.id === ids.videoClip)!;
    const landed = clips.find((clip) => clip.id === "clip-cut-right")!;
    for (const clip of [left, landed]) {
      expect(Math.round(clip.durationMs * clip.speed)).toBe(
        clip.outPointMs - clip.inPointMs,
      );
    }
    // The two windows are whole milliseconds, so the seam between them may
    // hold a millisecond of material that neither side reads — the honest
    // width of the grid, and never more.
    expect(Math.abs(landed.inPointMs - left.outPointMs)).toBeLessThanOrEqual(1);
    expect(left.inPointMs).toBe(0);
    expect(landed.outPointMs).toBe(3_000);
  });

  it("lands a hundred clips in one step, past the old fifty", () => {
    const moka = buildTimelineMokaFile();
    const timeline = createTimeline("Bulk");
    const withTimeline = apply(moka, { type: "addTimeline", timeline }).next;
    const trackId = timeline.tracks[0]!.id;
    const many = Array.from({ length: 100 }, (_, index) =>
      clipOf(withTimeline, timelineIds().videoAsset, trackId, index * 8_000),
    );
    const next = apply(withTimeline, {
      type: "addClips",
      timelineId: timeline.id,
      clips: many,
    }).next;
    expect(
      next.timelines!.find((held) => held.id === timeline.id)!.clips,
    ).toHaveLength(100);
  });

  it("lands no more clips than one step of history may hold", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const many = Array.from({ length: MAX_CLIPS_PER_COMMAND + 1 }, (_, i) =>
      clipOf(moka, ids.followerAsset, ids.videoTrack, 20_000 + i * 8_000),
    );
    const code = codeOf(() =>
      apply(moka, { type: "addClips", timelineId: ids.timeline, clips: many }),
    );
    expect(code).toBe("VALIDATION_FAILED");
  });
});

describe("transition commands", () => {
  it("inserts a block and moves what follows, and the undo puts the cut back", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const paired = pairAt(moka, ids, 4_000);
    const follower = paired.timelines![0].clips.find(
      (clip) => clip.startMs === 4_000,
    )!;
    const inserted = {
      ...clipOf(paired, ids.followerAsset, ids.videoTrack, 4_000),
      durationMs: 2_000,
      outPointMs: 2_000,
    };
    const next = expectRoundTrip(paired, {
      type: "insertClips",
      timelineId: ids.timeline,
      clips: [inserted],
      mode: "ripple",
    });
    const clips = next.timelines![0].clips;
    expect(clips).toHaveLength(3);
    expect(clips.find((clip) => clip.id === follower.id)!.startMs).toBe(6_000);
    expect(clips.find((clip) => clip.id === inserted.id)!.startMs).toBe(4_000);
  });

  it("splits a clip the insertion point falls inside", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const inserted = {
      ...clipOf(moka, ids.followerAsset, ids.videoTrack, 2_000),
      durationMs: 2_000,
      outPointMs: 2_000,
    };
    const next = expectRoundTrip(moka, {
      type: "insertClips",
      timelineId: ids.timeline,
      clips: [inserted],
      mode: "ripple",
    });
    const clips = next.timelines![0].clips;
    expect(clips).toHaveLength(3);
    expect(clips.find((clip) => clip.id === ids.videoClip)!.durationMs).toBe(
      2_000,
    );
    expect(clips.find((clip) => clip.id === inserted.id)!.startMs).toBe(2_000);
    const tail = clips.find(
      (clip) => clip.id !== ids.videoClip && clip.id !== inserted.id,
    )!;
    expect(tail.startMs).toBe(4_000);
    expect(tail.durationMs).toBe(2_000);
  });

  it("keeps a text clip on its own clock when a split lands", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const caption = createTextClip("Caption", ids.textTrack, 0);
    const withCaption = apply(moka, {
      type: "addClips",
      timelineId: ids.timeline,
      clips: [caption],
    }).next;
    const middle = createTextClip("Middle", ids.textTrack, 500);
    const next = apply(withCaption, {
      type: "insertClips",
      timelineId: ids.timeline,
      clips: [middle],
      mode: "ripple",
      rippleScope: "track",
    }).next;
    const clips = next.timelines![0].clips;
    const left = clips.find((clip) => clip.id === caption.id)!;
    expect([left.durationMs, left.inPointMs, left.outPointMs]).toEqual([
      500, 0, 500,
    ]);
    const tail = clips.find(
      (clip) =>
        clip.kind === "text" && clip.id !== caption.id && clip.id !== middle.id,
    )!;
    expect([
      tail.startMs,
      tail.durationMs,
      tail.inPointMs,
      tail.outPointMs,
    ]).toEqual([2_500, 1_500, 0, 1_500]);
  });

  it("overwrites the place it lands on, trimming or splitting around it", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const inside = {
      ...clipOf(moka, ids.followerAsset, ids.videoTrack, 1_000),
      durationMs: 1_000,
      outPointMs: 1_000,
    };
    const next = expectRoundTrip(moka, {
      type: "insertClips",
      timelineId: ids.timeline,
      clips: [inside],
      mode: "overwrite",
    });
    const clips = next.timelines![0].clips;
    expect(clips).toHaveLength(3);
    expect(clips.find((clip) => clip.id === ids.videoClip)!.durationMs).toBe(
      1_000,
    );
    expect(clips.find((clip) => clip.id === inside.id)!.startMs).toBe(1_000);

    const tailOnly = {
      ...clipOf(moka, ids.followerAsset, ids.videoTrack, 3_000),
      durationMs: 2_000,
      outPointMs: 2_000,
    };
    const trimmed = expectRoundTrip(moka, {
      type: "insertClips",
      timelineId: ids.timeline,
      clips: [tailOnly],
      mode: "overwrite",
    });
    expect(
      trimmed.timelines![0].clips.find((clip) => clip.id === ids.videoClip)!
        .durationMs,
    ).toBe(3_000);
  });

  it("moves every row for a ripple, or only the row it names", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const caption = createTextClip("Caption", ids.textTrack, 5_000);
    const withCaption = apply(moka, {
      type: "addClips",
      timelineId: ids.timeline,
      clips: [caption],
    }).next;
    const inserted = {
      ...clipOf(withCaption, ids.followerAsset, ids.videoTrack, 2_000),
      durationMs: 1_000,
      outPointMs: 1_000,
    };
    const all = apply(withCaption, {
      type: "insertClips",
      timelineId: ids.timeline,
      clips: [inserted],
      mode: "ripple",
      rippleScope: "all",
    }).next;
    expect(
      all.timelines![0].clips.find((clip) => clip.id === caption.id)!.startMs,
    ).toBe(6_000);

    const track = apply(withCaption, {
      type: "insertClips",
      timelineId: ids.timeline,
      clips: [inserted],
      mode: "ripple",
      rippleScope: "track",
    }).next;
    expect(
      track.timelines![0].clips.find((clip) => clip.id === caption.id)!.startMs,
    ).toBe(5_000);
  });

  it("refuses a landing on a locked row", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const locked = apply(moka, {
      type: "updateTrack",
      timelineId: ids.timeline,
      trackId: ids.videoTrack,
      patch: { locked: true },
    }).next;
    const inserted = {
      ...clipOf(locked, ids.followerAsset, ids.videoTrack, 2_000),
      durationMs: 1_000,
      outPointMs: 1_000,
    };
    expect(
      codeOf(() =>
        apply(locked, {
          type: "insertClips",
          timelineId: ids.timeline,
          clips: [inserted],
          mode: "ripple",
        }),
      ),
    ).toBe("TRACK_LOCKED");
  });

  it("deletes a clip and pulls what followed it back", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const paired = pairAt(moka, ids, 4_000);
    const follower = paired.timelines![0].clips.find(
      (clip) => clip.startMs === 4_000,
    )!;
    const { next, inverse } = apply(paired, {
      type: "rippleDeleteClips",
      timelineId: ids.timeline,
      clipIds: [ids.videoClip],
      scope: "all",
    });
    const clips = next.timelines![0].clips;
    expect(clips).toHaveLength(1);
    expect(clips.find((clip) => clip.id === follower.id)!.startMs).toBe(0);
    const undone = apply(next, ...inverse).next;
    const sorted = (moka: MokaFile) =>
      [...moka.timelines![0].clips].sort((a, b) => a.id.localeCompare(b.id));
    expect(sorted(undone)).toEqual(sorted(paired));
  });

  it("pulls every row for a ripple delete, or only the row it names", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const caption = createTextClip("Caption", ids.textTrack, 5_000);
    const withCaption = apply(moka, {
      type: "addClips",
      timelineId: ids.timeline,
      clips: [caption],
    }).next;
    const all = apply(withCaption, {
      type: "rippleDeleteClips",
      timelineId: ids.timeline,
      clipIds: [ids.videoClip],
      scope: "all",
    }).next;
    expect(
      all.timelines![0].clips.find((clip) => clip.id === caption.id)!.startMs,
    ).toBe(1_000);
    const track = apply(withCaption, {
      type: "rippleDeleteClips",
      timelineId: ids.timeline,
      clipIds: [ids.videoClip],
      scope: "track",
    }).next;
    expect(
      track.timelines![0].clips.find((clip) => clip.id === caption.id)!.startMs,
    ).toBe(5_000);
  });

  it("closes a gap and takes a gap out", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const later = clipOf(moka, ids.followerAsset, ids.videoTrack, 6_000);
    const withLater = apply(moka, {
      type: "addClips",
      timelineId: ids.timeline,
      clips: [later],
    }).next;
    const closed = expectRoundTrip(withLater, {
      type: "closeGaps",
      timelineId: ids.timeline,
      trackId: ids.videoTrack,
    });
    expect(
      closed.timelines![0].clips.find((clip) => clip.id === later.id)!.startMs,
    ).toBe(4_000);
    const withoutGap = expectRoundTrip(withLater, {
      type: "deleteGap",
      timelineId: ids.timeline,
      trackId: ids.videoTrack,
      atMs: 5_000,
    });
    expect(
      withoutGap.timelines![0].clips.find((clip) => clip.id === later.id)!
        .startMs,
    ).toBe(4_000);
    expect(
      codeOf(() =>
        apply(withLater, {
          type: "deleteGap",
          timelineId: ids.timeline,
          trackId: ids.videoTrack,
          atMs: 1_000,
        }),
      ),
    ).toBe("GAP_NOT_FOUND");
  });

  it("lands a transition on a butted seam, pulling the follower back itself, and the undo puts it back", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const withSecond = pairAt(moka, ids, 4_000);
    const second = clipAfter(withSecond, ids.videoClip)!;
    const next = expectRoundTrip(withSecond, {
      type: "addTransitions",
      timelineId: ids.timeline,
      transitions: [
        {
          id: "transition-new",
          afterClipId: ids.videoClip,
          kind: "crossfade",
          durationMs: DEFAULT_TRANSITION_MS,
          createdAt: NOW,
        },
      ],
    });
    const follower = next.timelines![0].clips.find(
      (clip) => clip.id === second.id,
    )!;
    expect(follower.startMs).toBe(4_000 - DEFAULT_TRANSITION_MS);
    expect(next.timelines![0].transitions).toHaveLength(1);
  });

  it("refuses a transition when the clips are not butted", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const withGap = pairAt(moka, ids, 4_500);
    const code = codeOf(() =>
      apply(withGap, {
        type: "addTransitions",
        timelineId: ids.timeline,
        transitions: [
          {
            id: "transition-new",
            afterClipId: ids.videoClip,
            kind: "crossfade",
            durationMs: DEFAULT_TRANSITION_MS,
            createdAt: NOW,
          },
        ],
      }),
    );
    expect(code).toBe("VALIDATION_FAILED");
  });

  it("refuses a second transition on the same seam", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const withSecond = pairAt(moka, ids, 4_000);
    const withOne = apply(withSecond, {
      type: "addTransitions",
      timelineId: ids.timeline,
      transitions: [
        {
          id: "transition-first",
          afterClipId: ids.videoClip,
          kind: "crossfade",
          durationMs: DEFAULT_TRANSITION_MS,
          createdAt: NOW,
        },
      ],
    }).next;
    const code = codeOf(() =>
      apply(withOne, {
        type: "addTransitions",
        timelineId: ids.timeline,
        transitions: [
          {
            id: "transition-second",
            afterClipId: ids.videoClip,
            kind: "wipe",
            durationMs: 400,
            createdAt: NOW,
          },
        ],
      }),
    );
    expect(code).toBe("CONFLICT");
  });

  it("refuses a transition on the last clip of a track", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const withText = apply(moka, {
      type: "addClips",
      timelineId: ids.timeline,
      clips: [createTextClip("Tail", ids.textTrack, 10_000)],
    }).next;
    const code = codeOf(() =>
      apply(withText, {
        type: "addTransitions",
        timelineId: ids.timeline,
        transitions: [
          {
            id: "transition-tail",
            afterClipId: withText.timelines![0].clips.find(
              (c) => c.kind === "text",
            )!.id,
            kind: "crossfade",
            durationMs: 400,
            createdAt: NOW,
          },
        ],
      }),
    );
    expect(code).toBe("VALIDATION_FAILED");
  });

  it("refuses a move that would break a seam", () => {
    const moka = buildCutMokaFile();
    const ids = cutFixtureIds();
    expect(
      codeOf(() =>
        apply(moka, {
          type: "moveClips",
          timelineId: ids.timeline,
          moves: [{ clipId: ids.clipA, startMs: 1_000 }],
        }),
      ),
    ).toBe("TRANSITION_SEAM");
    // Both ends move together and the seam travels with them.
    const shifted = apply(moka, {
      type: "moveClips",
      timelineId: ids.timeline,
      moves: [
        { clipId: ids.clipA, startMs: 1_000 },
        { clipId: ids.clipB, startMs: 1_000 + 4_000 - 500 },
      ],
    }).next;
    const timeline = shifted.timelines![0];
    expect(timeline.transitions).toHaveLength(1);
    expect(timeline.clips.find((clip) => clip.id === ids.clipB)!.startMs).toBe(
      4_500,
    );
  });

  it("refuses a trim that would break a seam", () => {
    const moka = buildCutMokaFile();
    const ids = cutFixtureIds();
    const code = codeOf(() =>
      apply(moka, {
        type: "updateClips",
        timelineId: ids.timeline,
        patches: [
          {
            clipId: ids.clipA,
            patch: { durationMs: 5_000, outPointMs: 5_000 },
          },
        ],
      }),
    );
    expect(code).toBe("TRANSITION_SEAM");
  });

  it("removes a transition and gives the follower its place back", () => {
    const moka = buildCutMokaFile();
    const ids = cutFixtureIds();
    const next = expectRoundTrip(moka, {
      type: "removeTransitions",
      timelineId: ids.timeline,
      transitionIds: [ids.transition],
    });
    const timeline = next.timelines![0];
    expect(timeline.transitions).toHaveLength(0);
    expect(timeline.clips.find((clip) => clip.id === ids.clipB)!.startMs).toBe(
      4_000,
    );
  });

  it("releases the seam and moves a clip in the way along", () => {
    const moka = buildCutMokaFile();
    const ids = cutFixtureIds();
    const withTail = apply(moka, {
      type: "addClips",
      timelineId: ids.timeline,
      clips: [clipOf(moka, ids.videoAssetA, ids.videoTrack, 5_500)],
    }).next;
    const next = apply(withTail, {
      type: "removeTransitions",
      timelineId: ids.timeline,
      transitionIds: [ids.transition],
    }).next;
    const timeline = next.timelines![0];
    expect(timeline.clips.find((clip) => clip.id === ids.clipB)!.startMs).toBe(
      4_000,
    );
    expect(timeline.clips.some((clip) => clip.startMs === 6_000)).toBe(true);
  });

  it("tears one seam out and keeps the chain behind it whole", () => {
    const { ids, moka, clipC } = seamChain();
    const next = apply(moka, {
      type: "removeTransitions",
      timelineId: ids.timeline,
      transitionIds: [ids.transition],
    }).next;
    const timeline = next.timelines![0];
    expect(timeline.transitions).toHaveLength(1);
    expect(timeline.clips.find((clip) => clip.id === ids.clipB)!.startMs).toBe(
      4_000,
    );
    expect(timeline.clips.find((clip) => clip.id === clipC)!.startMs).toBe(
      5_600,
    );
  });

  it("takes a clip and its seam out together, and the undo restores both in one step", () => {
    const moka = buildCutMokaFile();
    const ids = cutFixtureIds();
    const { next, inverse } = apply(moka, {
      type: "removeClips",
      timelineId: ids.timeline,
      clipIds: [ids.clipB],
    });
    expect(next.timelines![0].transitions).toHaveLength(0);
    expect(next.timelines![0].clips.map((clip) => clip.id).sort()).toEqual(
      [ids.clipA, ids.clipC, ids.clipD].sort(),
    );

    // The undo appends the clip it brings back, so the arrays are compared
    // as sets of clips rather than as lists: what has to hold is that every
    // clip is itself again and the seam is whole.
    const undone = apply(next, ...inverse).next;
    const timeline = undone.timelines![0];
    expect(timeline.clips.map((clip) => clip.id).sort()).toEqual(
      [ids.clipA, ids.clipB, ids.clipC, ids.clipD].sort(),
    );
    expect(timeline.transitions).toEqual(moka.timelines![0].transitions);
    for (const clip of moka.timelines![0].clips) {
      expect(
        timeline.clips.find((restored) => restored.id === clip.id),
      ).toEqual(clip);
    }
  });

  it("takes a whole seam chain down in one command, and puts it back", () => {
    const { ids, moka, clipC } = seamChain();
    const next = expectRoundTrip(moka, {
      type: "removeTransitions",
      timelineId: ids.timeline,
      transitionIds: [ids.transition, ids.transition2],
    });
    const timeline = next.timelines![0];
    expect(timeline.transitions).toHaveLength(0);
    expect(timeline.clips.find((clip) => clip.id === ids.clipB)!.startMs).toBe(
      4_000,
    );
    expect(timeline.clips.find((clip) => clip.id === clipC)!.startMs).toBe(
      6_000,
    );

    // Taking the same chain apart right to left leaves the same cut: every
    // release moves the suffix along with it.
    const reversed = apply(moka, {
      type: "removeTransitions",
      timelineId: ids.timeline,
      transitionIds: [ids.transition2, ids.transition],
    }).next;
    expect(
      reversed.timelines![0].clips.find((clip) => clip.id === ids.clipB)!
        .startMs,
    ).toBe(4_000);
    expect(
      reversed.timelines![0].clips.find((clip) => clip.id === clipC)!.startMs,
    ).toBe(6_000);
  });

  it("recomposes a seam chain through the public commands, and one undo puts the old chain back", () => {
    const { ids, moka, clipC } = seamChain();
    const next = expectRoundTrip(
      moka,
      {
        type: "removeTransitions",
        timelineId: ids.timeline,
        transitionIds: [ids.transition, ids.transition2],
      },
      {
        type: "addTransitions",
        timelineId: ids.timeline,
        transitions: [
          {
            id: ids.transition,
            afterClipId: ids.clipA,
            kind: "dipToBlack",
            durationMs: 400,
            createdAt: NOW,
          },
          {
            id: ids.transition2,
            afterClipId: ids.clipB,
            kind: "dipToBlack",
            durationMs: 400,
            createdAt: NOW,
          },
        ],
      },
    );
    const timeline = next.timelines![0];
    // The new window moved the first follower, and the second followed it.
    expect(timeline.clips.find((clip) => clip.id === ids.clipB)!.startMs).toBe(
      3_600,
    );
    expect(timeline.clips.find((clip) => clip.id === clipC)!.startMs).toBe(
      5_200,
    );
    expect(
      timeline.transitions.every(
        (transition) => transition.kind === "dipToBlack",
      ),
    ).toBe(true);
  });

  it("refuses a negative stroke width and keeps a stroked style through the codec", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const caption = createTextClip("Readable", ids.textTrack, 0);
    caption.text!.style.strokeWidth = -1;
    expect(
      codeOf(() =>
        apply(moka, {
          type: "addClips",
          timelineId: ids.timeline,
          clips: [caption],
        }),
      ),
    ).toBe("VALIDATION_FAILED");

    const miscoloured = createTextClip("Readable", ids.textTrack, 0);
    miscoloured.text!.style.strokeColor = "#10101";
    expect(
      codeOf(() =>
        apply(moka, {
          type: "addClips",
          timelineId: ids.timeline,
          clips: [miscoloured],
        }),
      ),
    ).toBe("VALIDATION_FAILED");

    const stroked = createTextClip("Readable", ids.textTrack, 0);
    stroked.text!.style.strokeWidth = 4;
    stroked.text!.style.strokeColor = "#101010";
    const landed = apply(moka, {
      type: "addClips",
      timelineId: ids.timeline,
      clips: [stroked],
    }).next;
    const decoded = decodeMokaFile(encodeMokaFile(landed));
    const style = decoded.timelines![0].clips.find(
      (clip) => clip.id === stroked.id,
    )!.text!.style;
    expect([style.strokeWidth, style.strokeColor]).toEqual([4, "#101010"]);
  });

  it("round-trips a document without timelines as carrying none", () => {
    const moka = buildGoldenMokaFile();
    const bytes = encodeMokaFile(moka);
    const decoded = decodeMokaFile(bytes);
    expect(decoded.timelines).toBeUndefined();
    expect(
      Buffer.from(encodeMokaFile(decoded)).equals(Buffer.from(bytes)),
    ).toBe(true);
  });
});

describe("timeline validation", () => {
  it("passes the cut fixture and names what is wrong with a broken one", () => {
    const moka = buildCutMokaFile();
    expect(validateMokaFile(moka)).toEqual([]);

    const ids = cutFixtureIds();
    const broken = buildCutMokaFile();
    broken.timelines![0].clips.find((clip) => clip.id === ids.clipB)!.startMs =
      2_000;
    const issues = validateMokaFile(broken);
    expect(issues.some((issue) => issue.code === "TRANSITION_SEAM")).toBe(true);
    expect(issues.every((issue) => issue.timelineId === ids.timeline)).toBe(
      true,
    );
  });
});

describe("timeline factories", () => {
  it("names three rows a reader can tell apart", () => {
    const tracks = defaultTimelineTracks();
    expect(tracks.map((t) => t.kind)).toEqual(["video", "audio", "text"]);
    expect(new Set(tracks.map((t) => t.name)).size).toBe(3);
    expect(tracks.every((track) => track.locked === false)).toBe(true);
  });

  it("reads an image clip for its default duration", () => {
    const asset = imageAsset();
    const clip = createClipFromAsset(asset, "track", 0);
    expect(clip.kind).toBe("video");
    expect(clip.durationMs).toBe(4_000);
    expect(clip.outPointMs).toBe(4_000);
  });

  it("reads a video clip for what the probe measured", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const asset = moka.resources.videos.find(
      (entry) => entry.id === ids.videoAsset,
    )!;
    const clip = createClipFromAsset(asset, ids.videoTrack, 0);
    expect(clip.durationMs).toBe(4_000);
    expect(clip.kind).toBe("video");
  });
});

// Helpers ---------------------------------------------------------------

/** The golden timeline with a second clip of its material landing `startMs`. */
function pairAt(
  moka: MokaFile,
  ids: ReturnType<typeof timelineIds>,
  startMs: number,
) {
  const second = clipOf(moka, ids.videoAsset, ids.videoTrack, startMs);
  return apply(moka, {
    type: "addClips",
    timelineId: ids.timeline,
    clips: [second],
  }).next;
}

/** The clip on the video track that is not the one the fixture names. */
function clipAfter(moka: MokaFile, clipId: string) {
  return moka
    .timelines![0].clips.filter((clip) => clip.id !== clipId)
    .find((clip) => clip.startMs >= 4_000);
}

/**
 * The cut fixture run into a chain: a clip C butted behind B and a 400ms
 * dip-to-black seam after B, which pulls C back to 5100ms.
 */
function seamChain() {
  const ids = cutFixtureIds();
  const moka = buildCutMokaFile();
  const c = clipOf(moka, ids.videoAssetA, ids.videoTrack, 5_500);
  const withC = apply(moka, {
    type: "addClips",
    timelineId: ids.timeline,
    clips: [c],
  }).next;
  const chained = apply(withC, {
    type: "addTransitions",
    timelineId: ids.timeline,
    transitions: [
      {
        id: ids.transition2,
        afterClipId: ids.clipB,
        kind: "dipToBlack",
        durationMs: 400,
        createdAt: NOW,
      },
    ],
  }).next;
  return { ids, moka: chained, clipC: c.id };
}

describe("what a cut is made of", () => {
  it("reads every file its clips take, once each and in order", () => {
    const ids = cutFixtureIds();
    const timeline = buildCutMokaFile().timelines![0];
    // The caption D on the text track takes no file, so it is not counted.
    expect(timelineAssetIds(timeline)).toEqual([
      ids.videoAssetA,
      ids.videoAssetB,
      ids.audioAsset,
    ]);
  });

  it("counts a file laid down twice once", () => {
    const ids = timelineIds();
    const timeline = buildTimelineMokaFile().timelines![0];
    timeline.clips.push({
      ...timeline.clips[0],
      id: "clip-again",
      startMs: 5_000,
    });
    expect(timelineAssetIds(timeline)).toEqual([ids.videoAsset]);
  });

  it("holds nothing for a cut with no clips", () => {
    const timeline = buildTimelineMokaFile().timelines![0];
    timeline.clips = [];
    expect(timelineAssetIds(timeline)).toEqual([]);
  });
});

describe("slip, slide, roll and range edits", () => {
  function threeButted() {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    const make = (id: string, assetId: string, startMs: number) => {
      const clip = clipOf(moka, assetId, ids.videoTrack, startMs);
      return {
        ...clip,
        id,
        startMs,
        durationMs: 2_000,
        inPointMs: 1_000,
        outPointMs: 3_000,
      };
    };
    moka.timelines![0].clips = [
      make("clip-a", ids.videoAsset, 0),
      make("clip-b", ids.followerAsset, 2_000),
      make("clip-c", ids.videoAsset, 4_000),
    ];
    return { moka, ids };
  }

  it("slips a clip's source window without moving it", () => {
    const { moka, ids } = threeButted();
    const next = expectRoundTrip(moka, {
      type: "slipClips",
      timelineId: ids.timeline,
      edits: [{ clipId: "clip-a", byMs: 500 }],
    });
    const clip = next.timelines![0].clips.find((held) => held.id === "clip-a")!;
    expect([
      clip.startMs,
      clip.durationMs,
      clip.inPointMs,
      clip.outPointMs,
    ]).toEqual([0, 2_000, 1_500, 3_500]);
  });

  it("slides a clip and carries its neighbours' edges", () => {
    const { moka, ids } = threeButted();
    const next = expectRoundTrip(moka, {
      type: "slideClips",
      timelineId: ids.timeline,
      moves: [{ clipId: "clip-b", byMs: 200 }],
    });
    const clips = next.timelines![0].clips;
    const a = clips.find((held) => held.id === "clip-a")!;
    const b = clips.find((held) => held.id === "clip-b")!;
    const c = clips.find((held) => held.id === "clip-c")!;
    expect([a.durationMs, a.outPointMs]).toEqual([2_200, 3_200]);
    expect(b.startMs).toBe(2_200);
    expect([c.startMs, c.durationMs, c.inPointMs]).toEqual([
      4_200, 1_800, 1_200,
    ]);
  });

  it("rolls one cut and keeps the total length", () => {
    const { moka, ids } = threeButted();
    const next = expectRoundTrip(moka, {
      type: "rollEdit",
      timelineId: ids.timeline,
      afterClipId: "clip-a",
      byMs: 200,
    });
    const clips = next.timelines![0].clips;
    const a = clips.find((held) => held.id === "clip-a")!;
    const b = clips.find((held) => held.id === "clip-b")!;
    expect(a.durationMs).toBe(2_200);
    expect([b.startMs, b.durationMs, b.inPointMs]).toEqual([
      2_200, 1_800, 1_200,
    ]);
    expect(clips.find((held) => held.id === "clip-c")!.startMs).toBe(4_000);
  });

  it("takes a range out across every row, splitting what it crosses", () => {
    const { moka, ids } = threeButted();
    const next = expectRoundTrip(moka, {
      type: "removeRange",
      timelineId: ids.timeline,
      startMs: 1_000,
      endMs: 3_000,
      scope: "all",
    });
    const clips = next.timelines![0].clips.sort(
      (a, b) => a.startMs - b.startMs,
    );
    expect(clips.map((clip) => [clip.startMs, clip.durationMs])).toEqual([
      [0, 1_000],
      [1_000, 1_000],
      [2_000, 2_000],
    ]);
  });
});

describe("markers and the working range", () => {
  it("adds, edits and removes markers, and the codec keeps them", () => {
    const moka = buildTimelineMokaFile();
    moka.timelines![0].schemaVersion = 2;
    const ids = timelineIds();
    const withMarkers = expectRoundTrip(moka, {
      type: "addMarkers",
      timelineId: ids.timeline,
      markers: [
        { id: "marker-1", atMs: 1_000, label: "Verse", color: "yellow" },
        { id: "marker-2", atMs: 3_000, label: "Drop", color: "red" },
      ],
    });
    expect(withMarkers.timelines![0].markers).toHaveLength(2);
    expect(
      decodeMokaFile(encodeMokaFile(withMarkers)).timelines![0].markers,
    ).toEqual(withMarkers.timelines![0].markers);

    const updated = expectRoundTrip(withMarkers, {
      type: "updateMarkers",
      timelineId: ids.timeline,
      patches: [
        { markerId: "marker-1", atMs: 1_500, label: "Chorus", color: "blue" },
      ],
    });
    expect(
      updated.timelines![0].markers!.find((marker) => marker.id === "marker-1"),
    ).toMatchObject({ atMs: 1_500, label: "Chorus", color: "blue" });

    const removed = expectRoundTrip(updated, {
      type: "removeMarkers",
      timelineId: ids.timeline,
      markerIds: ["marker-2"],
    });
    expect(removed.timelines![0].markers).toHaveLength(1);
  });

  it("sets and clears the working range", () => {
    const moka = buildTimelineMokaFile();
    moka.timelines![0].schemaVersion = 2;
    const ids = timelineIds();
    const set = expectRoundTrip(moka, {
      type: "setTimelineRange",
      timelineId: ids.timeline,
      inMs: 1_000,
      outMs: 3_000,
    });
    expect([set.timelines![0].inPointMs, set.timelines![0].outPointMs]).toEqual(
      [1_000, 3_000],
    );
    const cleared = expectRoundTrip(set, {
      type: "setTimelineRange",
      timelineId: ids.timeline,
      inMs: null,
      outMs: null,
    });
    expect([
      cleared.timelines![0].inPointMs,
      cleared.timelines![0].outPointMs,
    ]).toEqual([undefined, undefined]);
  });

  it("moves an older timeline to the current schema when it gains a marker", () => {
    const moka = buildTimelineMokaFile();
    const ids = timelineIds();
    moka.timelines![0].schemaVersion = 1;
    const next = apply(moka, {
      type: "addMarkers",
      timelineId: ids.timeline,
      markers: [{ id: "marker-1", atMs: 0, label: "Head", color: "white" }],
    }).next;
    expect(next.timelines![0].schemaVersion).toBe(2);
  });
});
