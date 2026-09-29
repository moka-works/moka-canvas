import { describe, expect, it } from "vitest";

import { createAct, createKeyframe } from "../../shared/domain/factories";
import { buildStoryMokaFile, storyIds } from "../../shared/domain/fixtures";
import type { MokaFile, ResourceEntry } from "../../shared/domain/types";
import { planAssembly } from "./assembly";
import { LINE_FIT_SPEED_MAX, planDubbing, type Measure } from "./dubbing";

const ids = storyIds();
const T0 = "2026-01-01T00:00:00.000Z";

const FLOOR_MS = 100;

/** An audio file on the shelf, as the project measured it. */
function voice(id: string, durationMs: number): ResourceEntry {
  return {
    id,
    name: `${id}.mp3`,
    path: `assets/audio/${id}.mp3`,
    mime: "audio/mpeg",
    createdAt: T0,
    updatedAt: T0,
    probe: {
      mime: "audio/mpeg",
      bytes: 2048,
      sha256: "1".repeat(64),
      durationMs,
    },
  };
}

/** What each file of the telling measures, as the shelf reports it. */
function shelf(assets: ResourceEntry[]): Measure {
  return (assetId) =>
    assets.find((held) => held.id === assetId)?.probe?.durationMs;
}

/**
 * The fixture's telling with the lines of its first shot read aloud.
 *
 * The shot runs two seconds of a five-second act; every reading is the test's
 * to measure, and a reading with no measurement stands for a file nobody
 * probed. A line with no asset named has not been read at all.
 */
function read(
  lines: Array<{ id: string; text: string; asset?: string }>,
): MokaFile {
  const moka = buildStoryMokaFile();
  const act = moka.stories![0]!.chapters[0]!.acts[0]!;
  const frame = act.keyframes[0]!;
  frame.dialogue = lines.map(({ id, text }) => ({ id, speaker: "林", text }));
  frame.voices = lines
    .filter((line) => line.asset !== undefined)
    .map((line) => ({
      lineId: line.id,
      text: line.text,
      voice: "",
      slot: { takes: [{ assetIds: [line.asset as string], createdAt: T0 }] },
    }));
  return moka;
}

function plan(moka: MokaFile, measure: Measure) {
  const story = moka.stories![0]!;
  return planDubbing(story, planAssembly(story, moka).units, measure);
}

describe("planDubbing", () => {
  it("leaves a reading that fits its shot where it is", () => {
    const moka = read([
      { id: "line-a", text: "车已经停运了。", asset: "said-a" },
    ]);
    const { cues, warnings } = plan(moka, shelf([voice("said-a", 1_200)]));

    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({
      chapterId: ids.chapterFirst,
      actId: ids.act,
      keyframeId: ids.frameFirst,
      lineId: "line-a",
      assetId: "said-a",
      startMs: 0,
      durationMs: 1_200,
      speed: 1,
      fit: "natural",
      windowMs: 2_000,
      materialMs: 1_200,
    });
    // A reading that fits is never stretched to fill the window: the rest of
    // the shot is silence, which is what the board says is there.
    expect(warnings).toEqual([]);
  });

  it("shares a shot's window out among the lines said in it", () => {
    const moka = read([
      { id: "line-a", text: "车已经停运了。", asset: "said-a" },
      { id: "line-b", text: "门也不开了。", asset: "said-b" },
    ]);
    const { cues } = plan(
      moka,
      shelf([voice("said-a", 900), voice("said-b", 1_100)]),
    );

    // Two lines in a two-second shot: a second each, and the one that does not
    // fit its own second is sped up rather than crowding the line before it.
    expect(
      cues.map((cue) => [cue.lineId, cue.startMs, cue.durationMs]),
    ).toEqual([
      ["line-a", 0, 900],
      ["line-b", 1_000, 1_000],
    ]);
    expect(cues[0]?.fit).toBe("natural");
    expect(cues[1]?.fit).toBe("sped");
    expect(cues[1]?.speed).toBeCloseTo(1.1, 5);
    expect(cues.every((cue) => cue.windowMs === 1_000)).toBe(true);
  });

  it("speeds a long reading up to fit, and no further than the ceiling", () => {
    const moka = read([
      { id: "line-a", text: "车已经停运了。", asset: "said-a" },
    ]);
    // Half again as long as its shot: exactly the most a voice is rushed.
    const material = Math.round(2_000 * LINE_FIT_SPEED_MAX);
    const { cues, warnings } = plan(moka, shelf([voice("said-a", material)]));

    expect(cues[0]?.fit).toBe("sped");
    expect(cues[0]?.speed).toBeCloseTo(LINE_FIT_SPEED_MAX, 5);
    expect(cues[0]?.durationMs).toBe(2_000);
    // The clip the assembly writes keeps the timeline's own identity: what is
    // played, over the speed it is played at, is exactly what the file holds.
    expect(Math.round(cues[0]!.durationMs * cues[0]!.speed)).toBe(material);
    expect(warnings).toEqual([]);
  });

  it("lets a reading too long even for that run past its shot, and says so", () => {
    const moka = read([
      { id: "line-a", text: "车已经停运了。", asset: "said-a" },
    ]);
    const { cues, warnings } = plan(moka, shelf([voice("said-a", 3_400)]));

    expect(cues[0]?.fit).toBe("overrun");
    expect(cues[0]?.startMs).toBe(0);
    // As fast as a voice may be played, and no faster: the rounding of the
    // duration is what keeps it from being exactly the ceiling.
    expect(cues[0]?.speed).toBeLessThanOrEqual(LINE_FIT_SPEED_MAX);
    expect(cues[0]?.speed).toBeCloseTo(LINE_FIT_SPEED_MAX, 2);
    const over = cues[0]!.durationMs - 2_000;
    expect(over).toBeGreaterThan(0);
    expect(Math.round(cues[0]!.durationMs * cues[0]!.speed)).toBe(3_400);
    expect(warnings).toEqual([
      expect.objectContaining({
        kind: "lineOverrun",
        lineId: "line-a",
        keyframeId: ids.frameFirst,
        overMs: over,
      }),
    ]);
    expect(warnings[0]?.place).toContain("1");
  });

  it("lays a reading nobody measured at the shot's own length", () => {
    const moka = read([
      { id: "line-a", text: "车已经停运了。", asset: "said-a" },
    ]);
    const { cues, warnings } = plan(moka, () => undefined);

    expect(cues[0]).toMatchObject({
      durationMs: 2_000,
      speed: 1,
      fit: "unmeasured",
      windowMs: 2_000,
    });
    expect(cues[0]?.materialMs).toBeUndefined();
    expect(warnings.map((warning) => warning.kind)).toEqual(["lineUnmeasured"]);
  });

  it("keeps a reading shorter than a clip may be up to the floor", () => {
    const moka = read([{ id: "line-a", text: "好。", asset: "said-a" }]);
    const { cues } = plan(moka, shelf([voice("said-a", 40)]));

    expect(cues[0]?.durationMs).toBe(FLOOR_MS);
    expect(cues[0]?.speed).toBeCloseTo(0.4, 5);
    expect(cues[0]?.fit).toBe("natural");
    // Slowed until the clip is long enough to hold: the identity still stands.
    expect(Math.round(cues[0]!.durationMs * cues[0]!.speed)).toBe(40);
  });

  it("cues each line inside its own shot, and not into the act's head", () => {
    const moka = read([
      { id: "line-a", text: "车已经停运了。", asset: "said-a" },
    ]);
    const story = moka.stories![0]!;
    const act = story.chapters[0]!.acts[0]!;
    // The second shot of the act says a line of its own, and the episode's
    // second act says another: each is read where it is said.
    act.keyframes[1]!.dialogue = [
      { id: "line-b", speaker: "周", text: "我们等一会儿。" },
    ];
    act.keyframes[1]!.voices = [
      {
        lineId: "line-b",
        text: "我们等一会儿。",
        voice: "",
        slot: { takes: [{ assetIds: ["said-b"], createdAt: T0 }] },
      },
    ];
    const second = createAct("第 2 幕 空车厢", "灯管忽明忽暗。");
    second.keyframes = [createKeyframe(0)];
    second.keyframes[0]!.dialogue = [
      { id: "line-c", speaker: "", text: "门开了。" },
    ];
    second.keyframes[0]!.durationMs = 1_000;
    second.keyframes[0]!.voices = [
      {
        lineId: "line-c",
        text: "门开了。",
        voice: "",
        slot: { takes: [{ assetIds: ["said-c"], createdAt: T0 }] },
      },
    ];
    second.video = {
      takes: [{ assetIds: ["asset-second-act"], createdAt: T0 }],
    };
    story.chapters[0]!.acts.push(second);
    moka.resources.videos.push({
      id: "asset-second-act",
      name: "second.mp4",
      path: "assets/videos/second.mp4",
      mime: "video/mp4",
      createdAt: T0,
      updatedAt: T0,
      probe: {
        mime: "video/mp4",
        bytes: 1024,
        sha256: "2".repeat(64),
        durationMs: 1_000,
      },
    });
    const measure = shelf([
      voice("said-a", 800),
      voice("said-b", 700),
      voice("said-c", 600),
    ]);
    const { cues } = plan(moka, measure);

    // The first shot runs 2s of the act's 5s clip, the second the 3s after it,
    // and the second act begins where the act before it ends.
    expect(cues.map((cue) => [cue.lineId, cue.startMs])).toEqual([
      ["line-a", 0],
      ["line-b", 2_000],
      ["line-c", 5_000],
    ]);
  });

  it("places nothing for a line nobody has read, keeping its share of the shot", () => {
    const moka = read([
      { id: "line-a", text: "车已经停运了。", asset: "said-a" },
      { id: "line-b", text: "门也不开了。" },
    ]);
    const { cues } = plan(moka, shelf([voice("said-a", 500)]));

    // Only the line that was read: the silence between the readings is kept
    // for the line that may yet be read into it.
    expect(cues.map((cue) => cue.lineId)).toEqual(["line-a"]);
    expect(cues[0]?.startMs).toBe(0);
    expect(cues[0]?.windowMs).toBe(1_000);
  });

  it("gives a line no window in a shot nobody filmed, shot by shot", () => {
    const moka = read([
      { id: "line-a", text: "车已经停运了。", asset: "said-a" },
    ]);
    const story = moka.stories![0]!;
    story.shotGranularity = "keyframe";
    const act = story.chapters[0]!.acts[0]!;
    // The first shot is filmed; the second is not, so its line has no picture
    // to be heard over and is not placed at all.
    act.keyframes[0]!.video = {
      takes: [{ assetIds: [ids.actVideo], createdAt: T0 }],
    };
    act.keyframes[1]!.dialogue = [
      { id: "line-c", speaker: "", text: "我们等一会儿。" },
    ];
    act.keyframes[1]!.voices = [
      {
        lineId: "line-c",
        text: "我们等一会儿。",
        voice: "",
        slot: { takes: [{ assetIds: ["said-c"], createdAt: T0 }] },
      },
    ];
    const { cues } = plan(
      moka,
      shelf([voice("said-a", 1_200), voice("said-c", 600)]),
    );

    // The filmed shot's own measured length is the window its line is read in.
    expect(cues.map((cue) => cue.lineId)).toEqual(["line-a"]);
    expect(cues[0]?.windowMs).toBe(5_000);
    expect(cues[0]?.fit).toBe("natural");
  });
});
