import { describe, expect, it } from "vitest";
import type {
  TextClipStyle,
  TimelineClip,
  TimelineDocument,
  TimelineTrack,
  TrackKind,
} from "../../../shared/domain";
import {
  composeFrame,
  containRect,
  fadeFactor,
  materialMoment,
  type FramePicture,
  type FrameSources,
} from "./compositor";

/**
 * The compositor, against a context that writes down what it was asked to draw.
 *
 * The picture is pixels a test cannot read, so the calls are the picture: which
 * colour filled the frame first, which sources were drawn over it and in what
 * order, how transparently, and what the filter was set to while it happened.
 */

interface RecordedCall {
  name: string;
  args: unknown[];
  fillStyle: string;
  strokeStyle: string;
  globalAlpha: number;
  filter: string;
  composite: string;
  font: string;
}

function recordingContext(): {
  ctx: CanvasRenderingContext2D;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const state: Record<string, unknown> = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    filter: "none",
    globalCompositeOperation: "source-over",
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
  };
  const record = (name: string) =>
    function (this: unknown, ...args: unknown[]) {
      calls.push({
        name,
        args,
        fillStyle: String(state.fillStyle),
        strokeStyle: String(state.strokeStyle),
        globalAlpha: Number(state.globalAlpha),
        filter: String(state.filter),
        composite: String(state.globalCompositeOperation),
        font: String(state.font),
      });
    };
  const ctx: Record<string, unknown> = {};
  for (const key of Object.keys(state))
    Object.defineProperty(ctx, key, {
      get: () => state[key],
      set: (value: unknown) => {
        state[key] = value;
      },
    });
  for (const name of [
    "fillRect",
    "drawImage",
    "translate",
    "rotate",
    "save",
    "restore",
    "beginPath",
    "roundRect",
    "fill",
    "stroke",
    "clip",
    "fillText",
    "strokeText",
    "measureText",
  ])
    ctx[name] =
      name === "measureText"
        ? (text: string) => ({ width: text.length * 6 })
        : record(name);
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const NOW = "2026-01-01T00:00:00.000Z";
/** Two markers a test can tell apart in the draw calls. */
const LOWER = { name: "lower" } as unknown as CanvasImageSource;
const UPPER = { name: "upper" } as unknown as CanvasImageSource;

function track(
  id: string,
  kind: TrackKind,
  patch: Partial<TimelineTrack> = {},
): TimelineTrack {
  return {
    id,
    kind,
    name: id,
    muted: false,
    hidden: false,
    locked: false,
    createdAt: NOW,
    ...patch,
  };
}

function clip(
  patch: Partial<TimelineClip> & { id: string; trackId: string },
): TimelineClip {
  return {
    kind: "video",
    label: "Piece",
    startMs: 0,
    durationMs: 2000,
    inPointMs: 0,
    outPointMs: 2000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    muted: false,
    opacity: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

function textStyle(patch: Partial<TextClipStyle> = {}): TextClipStyle {
  return {
    fontFamily: "Inter",
    fontSize: 40,
    color: "#ffffff",
    bold: false,
    italic: false,
    align: "center",
    position: "center",
    background: null,
    strokeWidth: 0,
    strokeColor: "#000000",
    ...patch,
  };
}

function cut(tracks: TimelineTrack[], clips: TimelineClip[]): TimelineDocument {
  return {
    id: "timeline-1",
    name: "Cut",
    schemaVersion: 1,
    settings: { fps: 30, width: 1000, height: 1000, background: "#102030" },
    tracks,
    clips,
    transitions: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function picture(
  source: CanvasImageSource,
  width: number,
  height: number,
  rotationDeg = 0,
): FramePicture {
  return { kind: "picture", picture: { source, width, height, rotationDeg } };
}

/** A source that answers with whatever the test prepared, and remembers being asked. */
function sourcesFor(
  frame: (clip: TimelineClip, materialMs: number) => FramePicture | null,
): FrameSources & { asked: { clipId: string; materialMs: number }[] } {
  const asked: { clipId: string; materialMs: number }[] = [];
  return {
    asked,
    async frameFor(clip, materialMs) {
      asked.push({ clipId: clip.id, materialMs });
      return frame(clip, materialMs);
    },
  };
}

function drawnSources(calls: RecordedCall[]): unknown[] {
  return calls
    .filter((call) => call.name === "drawImage")
    .map((call) => call.args[0]);
}

describe("drawing the frame under the playhead", () => {
  it("fills the frame with the timeline's background and draws the tracks in order", async () => {
    const lower = clip({ id: "lower", trackId: "v1" });
    const upper = clip({ id: "upper", trackId: "v2" });
    const timeline = cut(
      [track("v1", "video"), track("v2", "video")],
      [lower, upper],
    );
    const { ctx, calls } = recordingContext();
    const sources = sourcesFor((piece) =>
      picture(piece.id === "lower" ? LOWER : UPPER, 400, 200),
    );
    const report = await composeFrame(ctx, {
      width: 1000,
      height: 1000,
      timeline,
      atMs: 500,
      sources,
      filter: true,
    });

    const first = calls[0];
    expect(first.name).toBe("fillRect");
    expect(first.fillStyle).toBe("#102030");
    expect(first.args).toEqual([0, 0, 1000, 1000]);
    // The last track is the top of the stack, so it draws last.
    expect(drawnSources(calls)).toEqual([LOWER, UPPER]);
    expect(report?.clips.map((piece) => piece.id)).toEqual(["lower", "upper"]);
  });

  it("draws both sides of a seam window and blends them", async () => {
    const leader = clip({ id: "leader", trackId: "v1", durationMs: 4_000 });
    const follower = clip({
      id: "follower",
      trackId: "v1",
      startMs: 3_500,
      durationMs: 2_000,
      outPointMs: 2_000,
    });
    const timeline = cut([track("v1", "video")], [leader, follower]);
    timeline.transitions = [
      {
        id: "s1",
        afterClipId: "leader",
        kind: "crossfade",
        durationMs: 500,
        createdAt: NOW,
      },
    ];
    const { ctx, calls } = recordingContext();
    const sources = sourcesFor((piece) =>
      picture(piece.id === "leader" ? LOWER : UPPER, 400, 200),
    );
    // Halfway into the window: both frames are read, the follower at half alpha.
    const report = await composeFrame(ctx, {
      width: 1000,
      height: 1000,
      timeline,
      atMs: 3_750,
      sources,
      filter: true,
    });
    expect(drawnSources(calls)).toEqual([LOWER, UPPER]);
    expect(sources.asked.map((ask) => ask.clipId)).toEqual([
      "leader",
      "follower",
    ]);
    const alphas = calls
      .filter((call) => call.name === "drawImage")
      .map((call) => call.globalAlpha);
    expect(alphas[0]).toBeCloseTo(1, 4);
    expect(alphas[1]).toBeCloseTo(0.5, 4);
    // Both sides are the clips the frame drew, in draw order.
    expect(report?.clips.map((piece) => piece.id)).toEqual([
      "leader",
      "follower",
    ]);
    // The follower's own material clock is read through its pulled-back start.
    expect(sources.asked[1].materialMs).toBe(250);
  });

  it("multiplies a clip's opacity by its two fades", async () => {
    const timeline = cut(
      [track("v1", "video")],
      [
        clip({
          id: "faded",
          trackId: "v1",
          opacity: 0.5,
          fadeInMs: 1000,
          fadeOutMs: 1000,
        }),
      ],
    );
    const alphaAt = async (atMs: number): Promise<number> => {
      const { ctx, calls } = recordingContext();
      await composeFrame(ctx, {
        width: 1000,
        height: 1000,
        timeline,
        atMs,
        sources: sourcesFor(() => picture(LOWER, 400, 200)),
        filter: true,
      });
      return calls.find((call) => call.name === "drawImage")!.globalAlpha;
    };

    // A quarter into the fade in, half the clip's own presence.
    expect(await alphaAt(250)).toBeCloseTo(0.125, 4);
    expect(await alphaAt(1000)).toBeCloseTo(0.5, 4);
    expect(await alphaAt(1750)).toBeCloseTo(0.125, 4);
    // At the very tail the fade out has almost taken the clip.
    expect(await alphaAt(1999)).toBeLessThan(0.01);
  });

  it("treats a missing fade as no fade rather than dividing by it", () => {
    const bare = clip({ id: "bare", trackId: "v1" });
    expect(fadeFactor(bare, 0)).toBe(1);
    expect(fadeFactor(bare, 2000)).toBe(1);
    const half = clip({ id: "half", trackId: "v1", fadeInMs: 1000 });
    expect(fadeFactor(half, 500)).toBe(0.5);
  });

  it("fits a picture into the frame by its own shape, centred", () => {
    expect(containRect(400, 200, 1000, 1000)).toEqual({
      x: 0,
      y: 250,
      width: 1000,
      height: 500,
    });
    expect(containRect(200, 200, 1000, 1000)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 1000,
    });
    expect(containRect(200, 400, 1000, 500)).toEqual({
      x: 375,
      y: 0,
      width: 250,
      height: 500,
    });
    // A source with no shape of its own takes the whole frame rather than nothing.
    expect(containRect(0, 0, 800, 600)).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it("turns a picture the file stored turned, fitting its turned shape", async () => {
    const timeline = cut(
      [track("v1", "video")],
      [clip({ id: "turned", trackId: "v1" })],
    );
    const { ctx, calls } = recordingContext();
    await composeFrame(ctx, {
      width: 1000,
      height: 1000,
      timeline,
      atMs: 100,
      sources: sourcesFor(() => picture(LOWER, 400, 200, 90)),
      filter: true,
    });

    const rotations = calls.filter((call) => call.name === "rotate");
    expect(rotations).toHaveLength(1);
    expect(Number(rotations[0].args[0])).toBeCloseTo(Math.PI / 2, 6);
    // The turn happens around the box's own middle.
    const moved = calls.find((call) => call.name === "translate")!;
    expect(moved.args).toEqual([500, 500]);
    // A wide picture turned onto its side fits the frame as a tall one.
    const drawn = calls.find((call) => call.name === "drawImage")!;
    expect(drawn.args).toEqual([LOWER, -250, -500, 500, 1000]);
  });

  it("leaves a hidden track out of the frame", async () => {
    const timeline = cut(
      [track("v1", "video", { hidden: true }), track("v2", "video")],
      [
        clip({ id: "hidden", trackId: "v1" }),
        clip({ id: "shown", trackId: "v2" }),
      ],
    );
    const { ctx, calls } = recordingContext();
    const report = await composeFrame(ctx, {
      width: 1000,
      height: 1000,
      timeline,
      atMs: 100,
      sources: sourcesFor(() => picture(LOWER, 400, 200)),
      filter: true,
    });
    expect(report?.clips.map((piece) => piece.id)).toEqual(["shown"]);
    // The hidden row is not even asked about.
    expect(calls.filter((call) => call.name === "drawImage")).toHaveLength(1);
  });

  it("shows the leader through a seam window, which is where package 10 takes over", async () => {
    const leader = clip({ id: "leader", trackId: "v1", durationMs: 2000 });
    const follower = clip({
      id: "follower",
      trackId: "v1",
      startMs: 1500,
      durationMs: 2000,
      inPointMs: 0,
      outPointMs: 2000,
    });
    const timeline = cut([track("v1", "video")], [leader, follower]);
    const { ctx, calls } = recordingContext();
    const report = await composeFrame(ctx, {
      width: 1000,
      height: 1000,
      timeline,
      // Inside the window the two hold together.
      atMs: 1700,
      sources: sourcesFor(() => picture(LOWER, 400, 200)),
      filter: true,
    });
    expect(report?.clips.map((piece) => piece.id)).toEqual(["leader"]);
    expect(drawnSources(calls)).toHaveLength(1);
  });

  it("skips a row of sound: it has no picture to put in the frame", async () => {
    const timeline = cut(
      [track("a1", "audio"), track("v1", "video")],
      [
        clip({ id: "sound", trackId: "a1", kind: "audio" }),
        clip({ id: "shown", trackId: "v1" }),
      ],
    );
    const { ctx } = recordingContext();
    const asked = sourcesFor(() => picture(LOWER, 400, 200));
    const report = await composeFrame(ctx, {
      width: 1000,
      height: 1000,
      timeline,
      atMs: 100,
      sources: asked,
      filter: true,
    });
    expect(report?.clips.map((piece) => piece.id)).toEqual(["shown"]);
    expect(asked.asked.map((call) => call.clipId)).toEqual(["shown"]);
  });

  it("reads the material by the clip's own clock and its speed", () => {
    const sped = clip({
      id: "sped",
      trackId: "v1",
      startMs: 1000,
      inPointMs: 4000,
      speed: 2,
    });
    expect(materialMoment(sped, 1000)).toBe(4000);
    expect(materialMoment(sped, 1500)).toBe(5000);
  });

  it("drops a frame the reader has already moved past", async () => {
    const timeline = cut(
      [track("v1", "video")],
      [clip({ id: "piece", trackId: "v1" })],
    );
    const { ctx, calls } = recordingContext();
    const report = await composeFrame(ctx, {
      width: 1000,
      height: 1000,
      timeline,
      atMs: 100,
      sources: sourcesFor(() => picture(LOWER, 400, 200)),
      filter: true,
      isCurrent: () => false,
    });
    expect(report).toBeNull();
    expect(calls).toEqual([]);
  });

  it("fills the background for a moment with nothing on it", async () => {
    const timeline = cut(
      [track("v1", "video")],
      [clip({ id: "piece", trackId: "v1", startMs: 5000 })],
    );
    const { ctx, calls } = recordingContext();
    const report = await composeFrame(ctx, {
      width: 1000,
      height: 1000,
      timeline,
      atMs: 0,
      sources: sourcesFor(() => picture(LOWER, 400, 200)),
      filter: true,
    });
    expect(report?.clips).toEqual([]);
    expect(calls.map((call) => call.name)).toEqual(["fillRect"]);
  });

  it("draws a place being read rather than a black frame while a picture is on its way", async () => {
    const timeline = cut(
      [track("v1", "video")],
      [clip({ id: "piece", trackId: "v1" })],
    );
    const { ctx, calls } = recordingContext();
    await composeFrame(ctx, {
      width: 1000,
      height: 1000,
      timeline,
      atMs: 100,
      sources: sourcesFor(() => ({ kind: "waiting" })),
      filter: true,
    });
    expect(calls.some((call) => call.name === "roundRect")).toBe(true);
    const label = calls.find((call) => call.name === "fillText")!;
    expect(label.args[0]).toBe("Loading");
    expect(drawnSources(calls)).toEqual([]);
  });

  it("reports the material moment of the topmost picture it drew", async () => {
    const lower = clip({ id: "lower", trackId: "v1", inPointMs: 1000 });
    const upper = clip({
      id: "upper",
      trackId: "v2",
      startMs: 1000,
      inPointMs: 4000,
      speed: 2,
    });
    const timeline = cut(
      [track("v1", "video"), track("v2", "video")],
      [lower, upper],
    );
    const { ctx } = recordingContext();
    const report = await composeFrame(ctx, {
      width: 1000,
      height: 1000,
      timeline,
      atMs: 1500,
      sources: sourcesFor(() => picture(LOWER, 400, 200)),
      filter: true,
    });
    // The upper clip's clock, not the lower's: it drew last, so it is the one
    // the eye is on — 4000 + 500ms at double speed.
    expect(report?.materialMs).toBe(5000);
    expect(report?.waiting).toBe(false);
  });

  it("tells a loading place from a drawn picture, and a gap from both", async () => {
    const timeline = cut(
      [track("v1", "video")],
      [clip({ id: "piece", trackId: "v1" })],
    );
    const waiting = await composeFrame(recordingContext().ctx, {
      width: 1000,
      height: 1000,
      timeline,
      atMs: 100,
      sources: sourcesFor(() => ({ kind: "waiting" })),
      filter: true,
    });
    expect(waiting?.waiting).toBe(true);
    expect(waiting?.materialMs).toBeNull();

    const blank = await composeFrame(recordingContext().ctx, {
      width: 1000,
      height: 1000,
      timeline: cut([track("v1", "video")], []),
      atMs: 100,
      sources: sourcesFor(() => ({ kind: "waiting" })),
      filter: true,
    });
    expect(blank?.waiting).toBe(false);
    expect(blank?.materialMs).toBeNull();
  });

  it("reports no material moment for a picture the fades left out", async () => {
    const timeline = cut(
      [track("v1", "video")],
      [clip({ id: "faded", trackId: "v1", opacity: 0 })],
    );
    const { ctx, calls } = recordingContext();
    const report = await composeFrame(ctx, {
      width: 1000,
      height: 1000,
      timeline,
      atMs: 100,
      sources: sourcesFor(() => picture(LOWER, 400, 200)),
      filter: true,
    });
    // Nothing reached the canvas, so there is no moment under the eye to name.
    expect(drawnSources(calls)).toEqual([]);
    expect(report?.materialMs).toBeNull();
  });
});

describe("the grade a clip wears", () => {
  it("sets the filter before the picture is drawn and clears it after", async () => {
    const timeline = cut(
      [track("v1", "video")],
      [
        clip({
          id: "graded",
          trackId: "v1",
          adjust: { brightness: 0.2, contrast: 0, saturation: 0 },
          filter: "warm",
        }),
      ],
    );
    const { ctx, calls } = recordingContext();
    const report = await composeFrame(ctx, {
      width: 1000,
      height: 1000,
      timeline,
      atMs: 100,
      sources: sourcesFor(() => picture(LOWER, 400, 200)),
      filter: true,
    });
    const drawn = calls.find((call) => call.name === "drawImage")!;
    expect(drawn.filter).toBe("brightness(1.2)");
    expect(String(ctx.filter)).toBe("none");
    // The warm preset is a veil rather than a curve, blended over the picture.
    const veil = calls.find(
      (call) => call.name === "fillRect" && call.composite === "soft-light",
    )!;
    expect(veil.filter).toBe("none");
    expect(report?.coloursSkipped).toBe(false);
  });

  it("leaves an untouched clip unfiltered, and says nothing was skipped", async () => {
    const timeline = cut(
      [track("v1", "video")],
      [clip({ id: "plain", trackId: "v1" })],
    );
    const { ctx, calls } = recordingContext();
    const report = await composeFrame(ctx, {
      width: 1000,
      height: 1000,
      timeline,
      atMs: 100,
      sources: sourcesFor(() => picture(LOWER, 400, 200)),
      filter: true,
    });
    expect(calls.find((call) => call.name === "drawImage")!.filter).toBe(
      "none",
    );
    expect(report?.coloursSkipped).toBe(false);
  });

  it("shows a graded clip untouched when the canvas cannot filter, and says so", async () => {
    const timeline = cut(
      [track("v1", "video")],
      [
        clip({
          id: "graded",
          trackId: "v1",
          adjust: { brightness: -0.5, contrast: 0, saturation: 0 },
        }),
      ],
    );
    const { ctx, calls } = recordingContext();
    const report = await composeFrame(ctx, {
      width: 1000,
      height: 1000,
      timeline,
      atMs: 100,
      sources: sourcesFor(() => picture(LOWER, 400, 200)),
      filter: false,
    });
    expect(calls.find((call) => call.name === "drawImage")!.filter).toBe(
      "none",
    );
    expect(report?.coloursSkipped).toBe(true);
  });

  it("dresses the clip a dragged draft names in the draft's grade", async () => {
    const timeline = cut(
      [track("v1", "video"), track("v2", "video")],
      [
        clip({
          id: "dragged",
          trackId: "v1",
          adjust: { brightness: 0.2, contrast: 0, saturation: 0 },
        }),
        clip({
          id: "kept",
          trackId: "v2",
          adjust: { brightness: 0.2, contrast: 0, saturation: 0 },
        }),
      ],
    );
    const { ctx, calls } = recordingContext();
    await composeFrame(ctx, {
      width: 1000,
      height: 1000,
      timeline,
      atMs: 100,
      sources: sourcesFor(() => picture(LOWER, 400, 200)),
      filter: true,
      // The hand is on the lower clip only: the other keeps its own grade.
      adjustDraft: {
        clipIds: ["dragged"],
        adjust: { brightness: -0.5, contrast: 0.25, saturation: 0 },
      },
    });
    const drawn = calls.filter((call) => call.name === "drawImage");
    expect(drawn[0].filter).toBe("brightness(0.5) contrast(1.25)");
    expect(drawn[1].filter).toBe("brightness(1.2)");
  });

  it("leaves every clip on its own grade when the draft names none of them", async () => {
    const timeline = cut(
      [track("v1", "video")],
      [
        clip({
          id: "graded",
          trackId: "v1",
          adjust: { brightness: 0.2, contrast: 0, saturation: 0 },
        }),
      ],
    );
    const { ctx, calls } = recordingContext();
    await composeFrame(ctx, {
      width: 1000,
      height: 1000,
      timeline,
      atMs: 100,
      sources: sourcesFor(() => picture(LOWER, 400, 200)),
      filter: true,
      adjustDraft: {
        clipIds: [],
        adjust: { brightness: -1, contrast: 0, saturation: 0 },
      },
    });
    expect(calls.find((call) => call.name === "drawImage")!.filter).toBe(
      "brightness(1.2)",
    );
  });
});

describe("words on the picture", () => {
  const FRAME = { width: 1000, height: 1000 };

  async function drawText(
    style: Partial<TextClipStyle>,
    content = "One two three",
  ): Promise<RecordedCall[]> {
    const timeline = cut(
      [track("t1", "text")],
      [
        clip({
          id: "words",
          trackId: "t1",
          kind: "text",
          text: { content, style: textStyle(style) },
        }),
      ],
    );
    const { ctx, calls } = recordingContext();
    await composeFrame(ctx, {
      width: FRAME.width,
      height: FRAME.height,
      timeline,
      atMs: 100,
      sources: sourcesFor(() => null),
      filter: true,
    });
    return calls;
  }

  it("sets a line at the middle of the frame by default", async () => {
    const calls = await drawText({});
    const written = calls.find((call) => call.name === "fillText")!;
    expect(written.args[0]).toBe("One two three");
    // The block is one line of forty pixels: a hundred pixels of it, centred.
    expect(written.args[1]).toBe(500);
    expect(written.args[2]).toBe((FRAME.height - 50) / 2);
    expect(written.fillStyle).toBe("#ffffff");
  });

  it("places the block by the three positions and lines each line up by the three alignments", async () => {
    const top = await drawText({ position: "top", align: "left" });
    const topLine = top.find((call) => call.name === "fillText")!;
    expect(topLine.args[1]).toBe(60);
    expect(topLine.args[2]).toBe(60);

    const bottom = await drawText({ position: "bottom", align: "right" });
    const bottomLine = bottom.find((call) => call.name === "fillText")!;
    // The block's own width is what the right margin is measured against.
    expect(bottomLine.args[1]).toBe(1000 - 60);
    expect(bottomLine.args[2]).toBe(1000 - 60 - 50);
  });

  it("keeps the author's newlines and wraps anything longer than the frame", async () => {
    const kept = await drawText({ fontSize: 20 }, "first\nsecond");
    expect(
      kept
        .filter((call) => call.name === "fillText")
        .map((call) => call.args[0]),
    ).toEqual(["first", "second"]);

    // Six pixels a character in this context, so nine tenths of a kilopixel is
    // a hundred and fifty characters' worth of room.
    const long = "word ".repeat(40).trim();
    const wrapped = await drawText({ fontSize: 20 }, long);
    const lines = wrapped
      .filter((call) => call.name === "fillText")
      .map((call) => String(call.args[0]));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length * 6).toBeLessThanOrEqual(900);
  });

  it("draws the plate first, then the outline, then the words", async () => {
    const calls = await drawText({
      background: "#000000",
      strokeWidth: 4,
      strokeColor: "#ff0000",
    });
    const names = calls.map((call) => call.name);
    const plate = names.indexOf("roundRect");
    const outline = names.indexOf("strokeText");
    const written = names.indexOf("fillText");
    expect(plate).toBeGreaterThan(-1);
    expect(plate).toBeLessThan(outline);
    expect(outline).toBeLessThan(written);
    expect(calls.find((call) => call.name === "strokeText")!.strokeStyle).toBe(
      "#ff0000",
    );
    // The plate is filled with the colour the clip asked for.
    expect(
      calls.find(
        (call) => call.name === "fill" && call.fillStyle === "#000000",
      ),
    ).toBeDefined();
  });

  it("says nothing at all for a text clip with no words", async () => {
    const timeline = cut(
      [track("t1", "text")],
      [
        clip({
          id: "empty",
          trackId: "t1",
          kind: "text",
          text: { content: "", style: textStyle() },
        }),
      ],
    );
    const { ctx, calls } = recordingContext();
    await composeFrame(ctx, {
      width: FRAME.width,
      height: FRAME.height,
      timeline,
      atMs: 100,
      sources: sourcesFor(() => null),
      filter: true,
    });
    expect(calls.filter((call) => call.name === "fillText")).toEqual([]);
  });

  it("writes the words a draft names, and leaves the rest as the document holds them", async () => {
    const timeline = cut(
      [track("t1", "text"), track("t2", "text")],
      [
        clip({
          id: "edited",
          trackId: "t1",
          kind: "text",
          text: { content: "old words", style: textStyle() },
        }),
        clip({
          id: "kept",
          trackId: "t2",
          kind: "text",
          text: { content: "kept words", style: textStyle() },
        }),
      ],
    );
    const { ctx, calls } = recordingContext();
    await composeFrame(ctx, {
      width: FRAME.width,
      height: FRAME.height,
      timeline,
      atMs: 100,
      sources: sourcesFor(() => null),
      filter: true,
      // The hand is in the lower clip's words only: the other keeps its own.
      textDraft: {
        clipIds: ["edited"],
        text: { content: "new words", style: textStyle({ bold: true }) },
      },
    });
    const written = calls
      .filter((call) => call.name === "fillText")
      .map((call) => call.args[0]);
    expect(written).toEqual(["new words", "kept words"]);
    const fonts = calls
      .filter((call) => call.name === "fillText")
      .map((call) => call.font);
    expect(fonts[0]).toContain("bold");
    expect(fonts[1]).not.toContain("bold");
  });
});
