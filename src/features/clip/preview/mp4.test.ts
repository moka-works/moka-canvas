import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Mp4Error, parseFile, parseMoov } from "./mp4";

/**
 * The parser, against boxes built by hand.
 *
 * A file's structure is a language of sizes and offsets rather than a picture,
 * so the tests state the structure directly and read it back: no binary fixture
 * is needed to say what a `stts` table means. A small real file is parsed too,
 * at the end, because a parser that only understands boxes it wrote itself is
 * a parser that has agreed with the tests and nobody else.
 */

// ---------------------------------------------------------------------------
// Writing boxes: the sizes a file states about itself
// ---------------------------------------------------------------------------

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function u64(value: number): number[] {
  return [...u32(Math.floor(value / 2 ** 32)), ...u32(value >>> 0)];
}

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

function zeros(count: number): number[] {
  return new Array<number>(count).fill(0);
}

type Bytes = number | number[];

/** Flattened at the door: a box is written with its size stated over its own payload. */
function flat(parts: Bytes[]): number[] {
  return parts.flat();
}

function box(type: string, ...parts: Bytes[]): number[] {
  const payload = flat(parts);
  return [...u32(payload.length + 8), ...ascii(type), ...payload];
}

/** The same box written with a 64-bit size, which is how a large one says how large. */
function largeBox(type: string, ...parts: Bytes[]): number[] {
  const payload = flat(parts);
  return [0, 0, 0, 1, ...ascii(type), ...u64(payload.length + 16), ...payload];
}

function fullBox(type: string, ...parts: Bytes[]): number[] {
  return box(type, 0, 0, 0, 0, ...parts);
}

function bytes(...boxes: Bytes[]): Uint8Array {
  return Uint8Array.from(flat(boxes));
}

function view(raw: Uint8Array): DataView {
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
}

/** The code a refusal carries, which is what callers degrade on. */
function problem(work: () => unknown): string {
  try {
    work();
    return "";
  } catch (error) {
    return error instanceof Mp4Error ? error.code : "not-an-mp4-error";
  }
}

// ---------------------------------------------------------------------------
// The movie's own boxes
// ---------------------------------------------------------------------------

const IDENTITY = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];
const ROTATE_90 = [0, 0x0001_0000, 0, 0xffff_0000, 0, 0, 0, 0, 0x4000_0000];
const ROTATE_180 = [0xffff_0000, 0, 0, 0, 0xffff_0000, 0, 0, 0, 0x4000_0000];
const ROTATE_270 = [0, 0xffff_0000, 0, 0x0001_0000, 0, 0, 0, 0, 0x4000_0000];
/** Half scale on both axes: a transform this preview does not guess at. */
const ODD_MATRIX = [0x0000_8000, 0, 0, 0, 0x0000_8000, 0, 0, 0, 0x4000_0000];

function mvhd(timescale: number, duration: number): number[] {
  return fullBox(
    "mvhd",
    ...u32(0),
    ...u32(0),
    ...u32(timescale),
    ...u32(duration),
    ...zeros(80),
  );
}

function tkhd(matrix: number[]): number[] {
  return fullBox(
    "tkhd",
    ...u32(0),
    ...u32(0),
    ...u32(1),
    ...u32(0),
    ...u32(3000),
    ...zeros(8),
    ...u16(0),
    ...u16(0),
    ...u16(0x0100),
    ...u16(0),
    ...matrix.map((value) => u32(value >>> 0)).flat(),
    ...u32(1920 << 16),
    ...u32(1080 << 16),
  );
}

function mdhd(timescale: number, duration: number): number[] {
  return fullBox(
    "mdhd",
    ...u32(0),
    ...u32(0),
    ...u32(timescale),
    ...u32(duration),
    ...u16(0),
    ...u16(0),
  );
}

function hdlr(handler: string): number[] {
  return fullBox("hdlr", ...u32(0), ...ascii(handler), ...zeros(12), 0);
}

/** A visual sample entry: 78 bytes of its own before any child box. */
function visualEntry(
  format: string,
  width: number,
  height: number,
  ...children: number[][]
): number[] {
  return box(
    format,
    ...zeros(6),
    ...u16(1),
    ...u16(0),
    ...u16(0),
    ...zeros(12),
    ...u16(width),
    ...u16(height),
    ...u32(0x0048_0000),
    ...u32(0x0048_0000),
    ...u32(0),
    ...u16(1),
    ...zeros(32),
    ...u16(0x0018),
    ...u16(0xffff),
    ...children.flat(),
  );
}

function avcC(profile: number, compatibility: number, level: number): number[] {
  return box("avcC", 1, profile, compatibility, level, 0xff, 0, 0, 1, 0x60, 0);
}

function stsd(...entries: number[][]): number[] {
  return fullBox("stsd", ...u32(entries.length), ...entries.flat());
}

function stts(entries: [number, number][]): number[] {
  return fullBox(
    "stts",
    ...u32(entries.length),
    ...entries.flatMap(([count, delta]) => [...u32(count), ...u32(delta)]),
  );
}

function ctts(entries: [number, number][]): number[] {
  return fullBox(
    "ctts",
    ...u32(entries.length),
    ...entries.flatMap(([count, offset]) => [...u32(count), ...u32(offset)]),
  );
}

function stss(samples: number[]): number[] {
  return fullBox(
    "stss",
    ...u32(samples.length),
    ...samples.flatMap((n) => u32(n)),
  );
}

function stsz(sizes: number[]): number[] {
  return fullBox(
    "stsz",
    ...u32(0),
    ...u32(sizes.length),
    ...sizes.flatMap((n) => u32(n)),
  );
}

function stsc(entries: [number, number][]): number[] {
  return fullBox(
    "stsc",
    ...u32(entries.length),
    ...entries.flatMap(([first, perChunk]) => [
      ...u32(first),
      ...u32(perChunk),
      ...u32(1),
    ]),
  );
}

function stco(offsets: number[]): number[] {
  return fullBox(
    "stco",
    ...u32(offsets.length),
    ...offsets.flatMap((n) => u32(n)),
  );
}

interface VideoOptions {
  timescale?: number;
  duration?: number;
  rotation?: number[];
  format?: string;
  entry?: number[];
  sizes?: number[];
  times?: [number, number][];
  composition?: [number, number][];
  sync?: number[];
  chunks?: number[][];
  samplesPerChunk?: number;
}

/** A video track: the tables a seek reads, with the awkward ones left out unless asked for. */
function videoTrak(options: VideoOptions = {}): number[] {
  const sizes = options.sizes ?? [10, 10, 10];
  const offsets = (options.chunks ?? [[1000, 1010, 1020]]).flat();
  const stbl = box(
    "stbl",
    stsd(
      options.entry ??
        visualEntry(
          options.format ?? "avc1",
          1920,
          1080,
          avcC(0x64, 0x00, 0x1f),
        ),
    ),
    stts(options.times ?? [[sizes.length, 1000]]),
    ...(options.composition ? [ctts(options.composition)] : []),
    ...(options.sync ? [stss(options.sync)] : []),
    stsc([[1, options.samplesPerChunk ?? 1]]),
    stsz(sizes),
    stco(offsets),
  );
  const minf = box("minf", stbl);
  const mdia = box(
    "mdia",
    mdhd(options.timescale ?? 1000, options.duration ?? 3000),
    hdlr("vide"),
    minf,
  );
  return box("trak", tkhd(options.rotation ?? IDENTITY), mdia);
}

function moov(...tracks: number[][]): number[] {
  return box("moov", mvhd(1000, 3000), ...tracks);
}

function ftyp(): number[] {
  return box(
    "ftyp",
    ...ascii("isom"),
    ...u32(0x200),
    ...ascii("isom"),
    ...ascii("avc1"),
  );
}

function mdat(size = 64): number[] {
  return box("mdat", ...zeros(size));
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

describe("walking a file's boxes", () => {
  it("finds the moov whether it stands before or after the data", () => {
    const at = parseFile(bytes(ftyp(), moov(videoTrak()), mdat()));
    expect(at.video?.codec).toBe("avc1.64001f");
    expect(at.durationMs).toBe(3000);

    const after = parseFile(bytes(ftyp(), mdat(), moov(videoTrak())));
    expect(after.video?.samples).toHaveLength(3);
  });

  it("reads a box large enough to need a sixty-four bit size", () => {
    const entry = visualEntry("avc1", 640, 360, avcC(0x64, 0x00, 0x1f));
    const track = videoTrak({ entry, format: "avc1" });
    const large = largeBox("moov", ...mvhd(1000, 3000), ...track);
    const at = parseFile(bytes(ftyp(), large));
    expect(at.video?.width).toBe(640);
    expect(at.video?.height).toBe(360);
  });

  it("calls a fragmented file what it is", () => {
    const moof = box("moof");
    expect(problem(() => parseFile(bytes(ftyp(), moof)))).toBe(
      "MOKA_MP4_FRAGMENTED",
    );

    // A moov that says its samples live elsewhere is fragmented too.
    const fragmented = box("moov", mvhd(1000, 3000), box("mvex"));
    expect(problem(() => parseFile(bytes(ftyp(), fragmented)))).toBe(
      "MOKA_MP4_FRAGMENTED",
    );
  });

  it("refuses a box that runs past the end of what holds it", () => {
    const whole = bytes(ftyp(), moov(videoTrak()));
    const cut = whole.subarray(0, whole.byteLength - 40);
    expect(problem(() => parseFile(cut))).toBe("MOKA_MP4_INVALID");
  });

  it("refuses a file with no movie header at all", () => {
    expect(problem(() => parseFile(bytes(ftyp(), mdat())))).toBe(
      "MOKA_MP4_INVALID",
    );
    expect(
      problem(() => parseFile(bytes(ftyp(), box("moov", box("free"))))),
    ).toBe("MOKA_MP4_INVALID");
  });

  it("refuses a video in a format this preview cannot name", () => {
    const track = videoTrak({
      format: "wxyz",
      entry: visualEntry("wxyz", 640, 360),
    });
    expect(problem(() => parseFile(bytes(ftyp(), moov(track))))).toBe(
      "MOKA_MP4_UNSUPPORTED_CODEC",
    );
  });

  it("refuses a box that is not a moov when one is asked to be parsed", () => {
    expect(problem(() => parseMoov(view(bytes(mdat()))))).toBe(
      "MOKA_MP4_INVALID",
    );
  });

  it("names a VP9 picture in the codec string, decimal digits and all", () => {
    // The vpcC record holds profile and level as plain numbers and the depth
    // in a nibble, and the codec string writes all three as two-digit
    // decimals: a level of 1.1 is "11", not the "0b" its byte would be as hex.
    const packed = (depth: number, chroma: number): number =>
      (depth << 4) | chroma;
    const entry = visualEntry(
      "vp09",
      320,
      180,
      fullBox("vpcC", 0, 11, packed(8, 1), 1, 1, 1, 1, 0, 0),
    );
    const levelOne = parseFile(
      bytes(ftyp(), moov(videoTrak({ format: "vp09", entry }))),
    );
    expect(levelOne.video?.codec).toBe("vp09.00.11.08");

    const deeper = visualEntry(
      "vp09",
      1920,
      1080,
      fullBox("vpcC", 2, 41, packed(10, 1), 1, 1, 1, 1, 0, 0),
    );
    const levelFour = parseFile(
      bytes(ftyp(), moov(videoTrak({ format: "vp09", entry: deeper }))),
    );
    expect(levelFour.video?.codec).toBe("vp09.02.41.10");
  });
});

// ---------------------------------------------------------------------------
// What the tables say
// ---------------------------------------------------------------------------

describe("reading a track's sample tables", () => {
  it("places each sample's bytes and time from the chunk it sits in", () => {
    const raw = bytes(
      ftyp(),
      moov(
        videoTrak({
          times: [
            [2, 40],
            [1, 60],
          ],
          sizes: [10, 10, 10],
        }),
      ),
    );
    const video = parseFile(raw).video!;
    expect(video.samples.map((sample) => sample.offset)).toEqual([
      1000, 1010, 1020,
    ]);
    // Timescale 1000: a delta of 40 is forty milliseconds.
    expect(video.samples.map((sample) => sample.dtsUs)).toEqual([
      0, 40_000, 80_000,
    ]);
    // With no composition offsets, a sample shows at the time it decodes.
    expect(video.samples[2].ctsUs).toBe(80_000);
  });

  it("counts in whatever timebase the track keeps", () => {
    const fast = parseFile(
      bytes(ftyp(), moov(videoTrak({ timescale: 90_000, times: [[3, 3003]] }))),
    ).video!;
    // Three thousand and three ticks of ninety thousand is a frame and a hair.
    expect(fast.samples[1].ctsUs).toBe(33_367);

    const slow = parseFile(
      bytes(ftyp(), moov(videoTrak({ timescale: 1, times: [[3, 1]] }))),
    ).video!;
    expect(slow.samples[2].ctsUs).toBe(2_000_000);
  });

  it("takes the composition offset where there is one", () => {
    const withCtts = parseFile(
      bytes(ftyp(), moov(videoTrak({ composition: [[3, 500]] }))),
    ).video!;
    expect(withCtts.samples[0].ctsUs).toBe(500_000);
    expect(withCtts.samples[0].dtsUs).toBe(0);

    const plain = parseFile(bytes(ftyp(), moov(videoTrak()))).video!;
    expect(plain.samples[0].ctsUs).toBe(plain.samples[0].dtsUs);
  });

  it("reads a track with no sync table as every sample its own keyframe", () => {
    const all = parseFile(bytes(ftyp(), moov(videoTrak()))).video!;
    expect(all.samples.map((sample) => sample.key)).toEqual([true, true, true]);

    const some = parseFile(
      bytes(ftyp(), moov(videoTrak({ sync: [1, 4] }))),
    ).video!;
    expect(some.samples.map((sample) => sample.key)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("walks several chunks and a uniform sample size", () => {
    const raw = bytes(
      ftyp(),
      moov(
        videoTrak({
          sizes: [10, 10, 10, 10],
          chunks: [
            [2000, 3000],
            [4000, 5000],
          ],
          samplesPerChunk: 2,
        }),
      ),
    );
    const video = parseFile(raw).video!;
    // Two chunks of two samples each, the second chunk elsewhere in the file.
    expect(video.samples.map((sample) => sample.offset)).toEqual([
      2000, 2010, 3000, 3010,
    ]);
  });

  it("reads the picture's shape from the sample entry", () => {
    const video = parseFile(bytes(ftyp(), moov(videoTrak()))).video!;
    expect([video.width, video.height]).toEqual([1920, 1080]);
  });

  it("takes the rotation the display matrix asks for, and only the standard ones", () => {
    const rotationOf = (matrix: number[]): number =>
      parseFile(bytes(ftyp(), moov(videoTrak({ rotation: matrix })))).video!
        .rotationDeg;
    expect(rotationOf(IDENTITY)).toBe(0);
    expect(rotationOf(ROTATE_90)).toBe(90);
    expect(rotationOf(ROTATE_180)).toBe(180);
    expect(rotationOf(ROTATE_270)).toBe(270);
    // A matrix that is not one of the four is left alone rather than guessed.
    expect(rotationOf(ODD_MATRIX)).toBe(0);
  });

  it("keeps the movie's own timebase apart from the track's", () => {
    const at = parseFile(bytes(ftyp(), moov(videoTrak({ timescale: 90_000 }))));
    expect(at.timescale).toBe(1000);
    expect(at.durationMs).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// A file a camera could have written
// ---------------------------------------------------------------------------

describe("parsing a real file", () => {
  it("reads the sample tables of a small encoded MP4", () => {
    const raw = readFileSync(
      new URL("../../../../fixtures/tiny.mp4", import.meta.url),
    );
    const at = parseFile(new Uint8Array(raw));
    expect(at.video).not.toBeNull();
    const video = at.video!;
    // The file was written by AVFoundation, so its own boxes are nobody's guess.
    expect(
      video.codec.startsWith("avc1.") || video.codec.startsWith("hvc1."),
    ).toBe(true);
    expect(video.samples.length).toBeGreaterThan(0);
    expect(video.samples[0].key).toBe(true);
    expect(video.samples[0].size).toBeGreaterThan(0);
    expect(video.width).toBeGreaterThan(0);
    expect(video.height).toBeGreaterThan(0);
    expect(at.durationMs).toBeGreaterThan(0);
  });
});
