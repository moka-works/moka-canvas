import { describe, expect, it } from "vitest";
import {
  firstOverlap,
  parseSrt,
  serializeSrt,
  srtTime,
  type SrtCue,
} from "./srt";

/** What a parse that must succeed holds, for the tests that need its cues. */
function cuesOf(text: string): SrtCue[] {
  const parsed = parseSrt(text);
  if (!parsed.ok) throw new Error(`expected cues, got ${parsed.message}`);
  return parsed.cues;
}

const SAMPLE = [
  "1",
  "00:00:01,000 --> 00:00:03,500",
  "The first word",
  "on two lines",
  "",
  "2",
  "00:00:04.250 --> 00:00:06,000",
  '<i>And then</i> some <font color="#ffffff">more</font>',
  "",
].join("\n");

describe("parseSrt", () => {
  it("reads a plain file, joining an author's lines with newlines", () => {
    const parsed = parseSrt(SAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skipped).toBe(0);
    expect(parsed.cues).toEqual([
      { startMs: 1_000, endMs: 3_500, text: "The first word\non two lines" },
      { startMs: 4_250, endMs: 6_000, text: "And then some more" },
    ]);
  });

  it("tolerates a byte-order mark and carriage returns", () => {
    const parsed = parseSrt(
      "\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nhello\r\n\r\n",
    );
    expect(parsed).toEqual({
      ok: true,
      skipped: 0,
      cues: [{ startMs: 1_000, endMs: 2_000, text: "hello" }],
    });
  });

  it("accepts dotted milliseconds, one digit or three", () => {
    const cues = cuesOf("00:00:01.5 --> 00:00:02.25\nhello");
    expect(cues).toEqual([{ startMs: 1_500, endMs: 2_250, text: "hello" }]);
  });

  it("reads a block with no number line", () => {
    expect(cuesOf("00:00:01,000 --> 00:00:02,000\nhello")).toEqual([
      { startMs: 1_000, endMs: 2_000, text: "hello" },
    ]);
  });

  it("ignores the coordinates a tool pins to the time line", () => {
    const cues = cuesOf(
      "1\n00:00:01,000 --> 00:00:02,000 X1:100 X2:200 Y1:10 Y2:90\nhello",
    );
    expect(cues[0]).toEqual({ startMs: 1_000, endMs: 2_000, text: "hello" });
  });

  it("keeps hours past a day rather than wrapping them", () => {
    expect(cuesOf("100:00:00,000 --> 100:00:01,000\nlate")).toEqual([
      { startMs: 360_000_000, endMs: 360_001_000, text: "late" },
    ]);
  });

  it("skips bad blocks and counts them, keeping what was readable", () => {
    const parsed = parseSrt(
      [
        "this is not a cue",
        "",
        "2",
        "00:00:01,000 --> 00:00:02,000",
        "<i></i>",
        "",
        "3",
        "00:00:03,000 --> 00:00:04,000",
        "the one good line",
        "",
      ].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skipped).toBe(2);
    expect(parsed.cues).toEqual([
      { startMs: 3_000, endMs: 4_000, text: "the one good line" },
    ]);
  });

  it("refuses a file that yields no cue at all", () => {
    expect(parseSrt("")).toEqual({
      ok: false,
      message: "No subtitles found in the file",
    });
    expect(parseSrt("just some prose\nwithout a time line").ok).toBe(false);
  });
});

describe("firstOverlap", () => {
  const cue = (startMs: number, endMs: number): SrtCue => ({
    startMs,
    endMs,
    text: `${startMs}`,
  });

  it("lets cues butt end to start", () => {
    expect(firstOverlap([cue(0, 1_000), cue(1_000, 2_000)])).toBeNull();
  });

  it("lets cues stand a millisecond apart", () => {
    expect(firstOverlap([cue(0, 1_000), cue(1_001, 2_000)])).toBeNull();
  });

  it("finds a crossing pair, in start order", () => {
    const later = cue(500, 1_500);
    const first = cue(0, 1_000);
    const found = firstOverlap([later, first]);
    expect(found).toEqual([first, later]);
  });

  it("holds nothing for an empty list", () => {
    expect(firstOverlap([])).toBeNull();
  });
});

describe("serializeSrt", () => {
  it("writes comma milliseconds, renumbers from one, and keeps newlines", () => {
    const written = serializeSrt([
      { startMs: 65_000, endMs: 66_250, text: "second\nline" },
      { startMs: 1_000, endMs: 2_000, text: "first" },
    ]);
    expect(written).toBe(
      [
        "1",
        "00:00:01,000 --> 00:00:02,000",
        "first",
        "",
        "2",
        "00:01:05,000 --> 00:01:06,250",
        "second",
        "line",
        "",
      ].join("\n"),
    );
  });

  it("reads back what it wrote, cue for cue", () => {
    const original = cuesOf(SAMPLE);
    expect(cuesOf(serializeSrt(original))).toEqual(original);
  });
});

describe("round trip", () => {
  it("parseSrt(serializeSrt(parseSrt(x))) equals parseSrt(x)", () => {
    const once = parseSrt(SAMPLE);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    expect(parseSrt(serializeSrt(once.cues))).toEqual(once);
  });

  it("keeps the cues a file with a bad block yielded, cue for cue", () => {
    const messy = "not a cue\n\n1\n00:00:01,000 --> 00:00:02,000\nhello";
    const once = parseSrt(messy);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    expect(once.skipped).toBe(1);
    // What is written out is the clean file, so the second reading skips
    // nothing — the cues themselves are what has to survive the trip.
    expect(cuesOf(serializeSrt(once.cues))).toEqual(once.cues);
  });
});

describe("srtTime", () => {
  it("pads every field and never counts backwards", () => {
    expect(srtTime(0)).toBe("00:00:00,000");
    expect(srtTime(3_661_007)).toBe("01:01:01,007");
    expect(srtTime(-5)).toBe("00:00:00,000");
  });
});
