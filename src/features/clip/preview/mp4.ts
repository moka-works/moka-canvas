import type { AssetId } from "../../../shared/domain";

/**
 * The picture's own index, read out of an MP4's boxes.
 *
 * A preview needs to know where one frame's bytes are, not what a whole file
 * weighs: the boxes that describe the samples are read, the bytes they point at
 * are fetched a window at a time, and the video data itself never passes
 * through here. The parse is pure so it can be tested against boxes built by
 * hand, and the ranged walk is what keeps opening a file to a few kilobytes.
 *
 * Nothing here turns a frame: WebCodecs has no idea a `tkhd` matrix exists, so
 * the rotation the file asks for is read out and the compositor applies it.
 */

/** One sample: where its bytes are and when it shows. */
export interface Mp4Sample {
  /** The byte the sample starts at, from the head of the file. */
  offset: number;
  size: number;
  /** Decode time, in microseconds from the head of the track. */
  dtsUs: number;
  /** Presentation time: decode time plus the composition offset. */
  ctsUs: number;
  /** Whether the sample decodes from itself, which is where seeking starts. */
  key: boolean;
}

export interface Mp4VideoTrack {
  /** The RFC 6381 string a decoder is configured with. */
  codec: string;
  /** The avcC/hvcC record, for the codecs whose configuration lives beside the samples. */
  description?: Uint8Array;
  /** What the display matrix asks for, in degrees; 0 when it asks for nothing standard. */
  rotationDeg: number;
  /** The picture's size as the sample entry states it. */
  width: number;
  height: number;
  samples: Mp4Sample[];
}

export interface Mp4AudioTrack {
  codec: string;
  description?: Uint8Array;
  /** Ticks a second on the track's own clock, which is not the movie's. */
  timescale: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
  samples: Mp4Sample[];
}

export interface Mp4Index {
  timescale: number;
  durationMs: number;
  video: Mp4VideoTrack | null;
  audio: Mp4AudioTrack | null;
}

export type Mp4Problem =
  "MOKA_MP4_INVALID" | "MOKA_MP4_FRAGMENTED" | "MOKA_MP4_UNSUPPORTED_CODEC";

/**
 * Why a file could not be read, as a code the caller degrades on rather than a
 * throw it has to interpret: an unreadable file, a fragmented one (whose
 * samples live in `moof` boxes this preview does not walk), and a codec the
 * browser will not take. Every one of them is answered by the element engine.
 */
export class Mp4Error extends Error {
  readonly code: Mp4Problem;

  constructor(code: Mp4Problem, message: string) {
    super(message);
    this.name = "Mp4Error";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

interface Box {
  type: string;
  /** Where the box itself starts. */
  at: number;
  /** How many bytes its header takes, 8 or 16. */
  headerSize: number;
  /** Where its payload starts. */
  start: number;
  /** How long its payload is. */
  size: number;
}

function invalid(message: string): Mp4Error {
  return new Mp4Error("MOKA_MP4_INVALID", message);
}

function need(view: DataView, at: number, bytes: number): void {
  if (at < 0 || bytes < 0 || at + bytes > view.byteLength)
    throw invalid("A box is cut short");
}

function u8(view: DataView, at: number): number {
  need(view, at, 1);
  return view.getUint8(at);
}

function u16(view: DataView, at: number): number {
  need(view, at, 2);
  return view.getUint16(at);
}

function u32(view: DataView, at: number): number {
  need(view, at, 4);
  return view.getUint32(at);
}

/** A 64-bit size as a number: a box longer than this is not one to read anyway. */
function u64(view: DataView, at: number): number {
  need(view, at, 8);
  const value = view.getBigUint64(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw invalid("A box claims a size nobody can hold");
  return Number(value);
}

function i32(view: DataView, at: number): number {
  need(view, at, 4);
  return view.getInt32(at);
}

function fourcc(view: DataView, at: number): string {
  need(view, at, 4);
  let out = "";
  for (let i = 0; i < 4; i += 1)
    out += String.fromCharCode(view.getUint8(at + i));
  return out;
}

/** One box, read from its header. `end` is the container's end, for a size of zero. */
function readBox(view: DataView, at: number, end: number): Box {
  need(view, at, 8);
  let size = u32(view, at);
  const type = fourcc(view, at + 4);
  let headerSize = 8;
  if (size === 1) {
    size = u64(view, at + 8);
    headerSize = 16;
  } else if (size === 0) {
    // To the end of the container, which is how a last box says "the rest".
    size = end - at;
  }
  if (size < headerSize) throw invalid("A box is smaller than its own header");
  const payload = size - headerSize;
  if (at + headerSize + payload > end)
    throw invalid("A box runs past the end of what holds it");
  return { type, at, headerSize, start: at + headerSize, size: payload };
}

function children(view: DataView, parent: Box): Box[] {
  const boxes: Box[] = [];
  let at = parent.start;
  const end = parent.start + parent.size;
  while (at + 8 <= end) {
    const box = readBox(view, at, end);
    boxes.push(box);
    at = box.at + box.headerSize + box.size;
  }
  return boxes;
}

function find(boxes: Box[], type: string): Box | undefined {
  return boxes.find((box) => box.type === type);
}

/** The named box among a box's children. */
function inside(view: DataView, parent: Box, type: string): Box | undefined {
  return find(children(view, parent), type);
}

/** The bytes of a box's payload, copied so they outlive the buffer they arrived in. */
function payload(view: DataView, box: Box): Uint8Array {
  return new Uint8Array(
    view.buffer,
    view.byteOffset + box.start,
    box.size,
  ).slice();
}

function toUs(ticks: number, timescale: number): number {
  return Math.round((ticks * 1_000_000) / timescale);
}

function toMs(ticks: number, timescale: number): number {
  return Math.round((ticks * 1_000) / timescale);
}

// ---------------------------------------------------------------------------
// The movie header and the tracks
// ---------------------------------------------------------------------------

interface MovieHeader {
  timescale: number;
  durationTicks: number;
}

function parseMvhd(view: DataView, mvhd: Box): MovieHeader {
  const version = u8(view, mvhd.start);
  // After the version and flags: creation, modification, timescale, duration.
  const at = mvhd.start + 4;
  const timescale = version === 1 ? u32(view, at + 16) : u32(view, at + 8);
  const duration = version === 1 ? u64(view, at + 20) : u32(view, at + 12);
  return { timescale, durationTicks: duration };
}

interface MediaHeader {
  timescale: number;
  durationTicks: number;
}

function parseMdhd(view: DataView, mdhd: Box): MediaHeader {
  const version = u8(view, mdhd.start);
  const at = mdhd.start + 4;
  const timescale = version === 1 ? u32(view, at + 16) : u32(view, at + 8);
  const duration = version === 1 ? u64(view, at + 20) : u32(view, at + 12);
  return { timescale, durationTicks: duration };
}

/**
 * How far the file asks for the picture to be turned.
 *
 * Only the four matrices a camera or a phone writes are read: anything else is
 * a transform this preview would have to guess at, and guessing at a picture's
 * shape is worse than leaving it as it was stored.
 */
function rotationOf(view: DataView, tkhd: Box): number {
  const version = u8(view, tkhd.start);
  // The matrix is the ninth thing after the version and flags, and its two
  // timestamps are the only fields whose width the version changes.
  const at = version === 1 ? tkhd.start + 52 : tkhd.start + 40;
  const fixed = (index: number) => i32(view, at + index * 4) / 65_536;
  const round = (value: number) => Math.round(value);
  const a = round(fixed(0));
  const b = round(fixed(1));
  const c = round(fixed(3));
  const d = round(fixed(4));
  if (a === 1 && b === 0 && c === 0 && d === 1) return 0;
  if (a === 0 && b === 1 && c === -1 && d === 0) return 90;
  if (a === -1 && b === 0 && c === 0 && d === -1) return 180;
  if (a === 0 && b === -1 && c === 1 && d === 0) return 270;
  return 0;
}

/** A sample entry's own facts: what the codec is and how big the picture is. */
interface SampleEntry {
  codec: string;
  description?: Uint8Array;
  width: number;
  height: number;
  sampleRate: number;
  channels: number;
}

/** Where the child boxes of each kind of sample entry begin, from its payload. */
const VISUAL_CHILDREN_AT = 78;
const AUDIO_CHILDREN_AT = 28;

function hex2(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function childOf(
  view: DataView,
  entry: Box,
  offset: number,
  type: string,
): Box | undefined {
  const boxes: Box[] = [];
  let at = entry.start + offset;
  const end = entry.start + entry.size;
  while (at + 8 <= end) {
    const box = readBox(view, at, end);
    boxes.push(box);
    at = box.at + box.headerSize + box.size;
  }
  return find(boxes, type);
}

/**
 * The hvcC record's codec string: the profile, the reversed compatibility
 * flags, the tier and level, and whichever constraint bytes are set.
 */
function hevcCodec(prefix: string, record: Uint8Array): string {
  if (record.byteLength < 13) throw invalid("An hvcC record is cut short");
  const space = ["", "A", "B", "C"][record[1] >> 6];
  const profile = record[1] & 0x1f;
  const tier = record[1] & 0x20 ? "H" : "L";
  const flags =
    ((record[2] << 24) | (record[3] << 16) | (record[4] << 8) | record[5]) >>>
    0;
  let reversed = 0;
  for (let bit = 0; bit < 32; bit += 1)
    reversed = ((reversed << 1) | ((flags >>> bit) & 1)) >>> 0;
  const parts = [
    `${prefix}.${space}${profile}`,
    reversed.toString(16),
    `${tier}${record[12]}`,
  ];
  for (let at = 6; at < 12; at += 1)
    if (record[at] !== 0) parts.push(hex2(record[at]));
  return parts.join(".");
}

/**
 * The vp09 codec string from a vpcC record, which is where it lives.
 *
 * The three fields are two-digit decimals — a profile of 2 is "02", a level of
 * 1.1 is "11" — where the record holds them as plain numbers: writing the level
 * byte as hex turns 11 into "0b", which no decoder recognises.
 */
function vp9Codec(record: Uint8Array): string {
  if (record.byteLength < 7) return "vp09";
  const dec2 = (value: number) => String(value).padStart(2, "0");
  return `vp09.${dec2(record[4])}.${dec2(record[5])}.${dec2(record[6] >> 4)}`;
}

/** The av01 profile from an av1C record. */
function av1Codec(record: Uint8Array): string {
  if (record.byteLength < 7) return "av01";
  const profile = record[4] >> 5;
  const level = record[4] & 0x1f;
  const tier = record[5] & 0x80 ? "H" : "M";
  return `av01.${profile}.${String(level).padStart(2, "0")}${tier}`;
}

/** The object type an audio sample entry's esds names, for the codec string. */
function esdsObjectType(record: Uint8Array): number | null {
  for (let at = 4; at + 2 < record.byteLength; at += 1) {
    // The decoder configuration descriptor's tag, then its own length byte.
    if (record[at] === 0x04 && record[at + 1] < 0x80) return record[at + 2];
  }
  return null;
}

function entryFacts(view: DataView, entry: Box): SampleEntry | null {
  // A visual sample entry states its picture 24 bytes into its own payload.
  const width = entry.type === "mp4a" ? 0 : u16(view, entry.start + 24);
  const height = entry.type === "mp4a" ? 0 : u16(view, entry.start + 26);
  switch (entry.type) {
    case "avc1":
    case "avc3": {
      const avcC = childOf(view, entry, VISUAL_CHILDREN_AT, "avcC");
      if (!avcC) throw unsupported("An AVC entry carries no avcC record");
      const description = payload(view, avcC);
      if (description.byteLength < 4)
        throw invalid("An avcC record is cut short");
      return {
        codec: `${entry.type}.${hex2(description[1])}${hex2(description[2])}${hex2(description[3])}`,
        description,
        width,
        height,
        sampleRate: 0,
        channels: 0,
      };
    }
    case "hvc1":
    case "hev1": {
      const hvcC = childOf(view, entry, VISUAL_CHILDREN_AT, "hvcC");
      if (!hvcC) throw unsupported("An HEVC entry carries no hvcC record");
      const description = payload(view, hvcC);
      return {
        codec: hevcCodec(entry.type, description),
        description,
        width,
        height,
        sampleRate: 0,
        channels: 0,
      };
    }
    case "vp09": {
      // VP9 configures from its codec string alone, so a vpcC is a nicety.
      const vpcC = childOf(view, entry, VISUAL_CHILDREN_AT, "vpcC");
      return {
        codec: vpcC ? vp9Codec(payload(view, vpcC)) : "vp09",
        width,
        height,
        sampleRate: 0,
        channels: 0,
      };
    }
    case "av01": {
      const av1C = childOf(view, entry, VISUAL_CHILDREN_AT, "av1C");
      return {
        codec: av1C ? av1Codec(payload(view, av1C)) : "av01",
        width,
        height,
        sampleRate: 0,
        channels: 0,
      };
    }
    case "mp4a": {
      const esds = childOf(view, entry, AUDIO_CHILDREN_AT, "esds");
      const description = esds ? payload(view, esds) : undefined;
      const objectType = description ? esdsObjectType(description) : null;
      return {
        codec: objectType === null ? "mp4a" : `mp4a.${hex2(objectType)}`,
        description,
        width: 0,
        height: 0,
        channels: u16(view, entry.start + 16),
        // The sample rate is written as a 16.16 fixed number.
        sampleRate: u32(view, entry.start + 24) >>> 16,
      };
    }
    default:
      return null;
  }
}

function unsupported(message: string): Mp4Error {
  return new Mp4Error("MOKA_MP4_UNSUPPORTED_CODEC", message);
}

/**
 * The first sample entry this preview knows how to read.
 *
 * A track may list several entries; only the first one a decoder can be
 * configured from is worth anything here, and a track with none of them is one
 * the element engine takes over.
 */
function parseStsd(view: DataView, stsd: Box): SampleEntry | null {
  const end = stsd.start + stsd.size;
  const count = u32(view, stsd.start + 4);
  let at = stsd.start + 8;
  for (let index = 0; index < count && at + 8 <= end; index += 1) {
    const entry = readBox(view, at, end);
    at = entry.at + entry.headerSize + entry.size;
    const facts = entryFacts(view, entry);
    if (facts) return facts;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The sample tables
// ---------------------------------------------------------------------------

function parseStts(view: DataView, stts: Box): number[] {
  const count = u32(view, stts.start + 4);
  const deltas: number[] = [];
  let at = stts.start + 8;
  for (let index = 0; index < count; index += 1) {
    const samples = u32(view, at);
    const delta = u32(view, at + 4);
    for (let n = 0; n < samples; n += 1) deltas.push(delta);
    at += 8;
  }
  return deltas;
}

function parseCtts(view: DataView, ctts: Box): number[] {
  const count = u32(view, ctts.start + 4);
  const offsets: number[] = [];
  let at = ctts.start + 8;
  for (let index = 0; index < count; index += 1) {
    const samples = u32(view, at);
    // Signed: version 1 lets an offset reach back before the decode time.
    const offset = i32(view, at + 4);
    for (let n = 0; n < samples; n += 1) offsets.push(offset);
    at += 8;
  }
  return offsets;
}

function parseStsz(view: DataView, stsz: Box): number[] {
  const uniform = u32(view, stsz.start + 4);
  const count = u32(view, stsz.start + 8);
  if (uniform !== 0) return new Array<number>(count).fill(uniform);
  const sizes: number[] = [];
  let at = stsz.start + 12;
  for (let index = 0; index < count; index += 1) {
    sizes.push(u32(view, at));
    at += 4;
  }
  return sizes;
}

function parseStco(view: DataView, box: Box, wide: boolean): number[] {
  const count = u32(view, box.start + 4);
  const offsets: number[] = [];
  let at = box.start + 8;
  for (let index = 0; index < count; index += 1) {
    offsets.push(wide ? u64(view, at) : u32(view, at));
    at += wide ? 8 : 4;
  }
  return offsets;
}

interface ChunkMap {
  firstChunk: number;
  samplesPerChunk: number;
}

function parseStsc(view: DataView, stsc: Box | undefined): ChunkMap[] {
  if (!stsc) return [{ firstChunk: 1, samplesPerChunk: 1 }];
  const count = u32(view, stsc.start + 4);
  const map: ChunkMap[] = [];
  let at = stsc.start + 8;
  for (let index = 0; index < count; index += 1) {
    map.push({
      firstChunk: u32(view, at),
      samplesPerChunk: u32(view, at + 4),
    });
    at += 12;
  }
  return map;
}

/** Which samples are sync samples; a track with no table is read as all of them. */
function parseStss(
  view: DataView,
  stss: Box | undefined,
  count: number,
): boolean[] {
  const keys = new Array<boolean>(count).fill(stss === undefined);
  if (!stss) return keys;
  const entries = u32(view, stss.start + 4);
  let at = stss.start + 8;
  for (let index = 0; index < entries; index += 1) {
    const sample = u32(view, at) - 1;
    if (sample >= 0 && sample < count) keys[sample] = true;
    at += 4;
  }
  return keys;
}

/** The samples of a track in decode order, with the byte each one starts at. */
function parseSampleTable(
  view: DataView,
  boxes: Box[],
  timescale: number,
): Mp4Sample[] {
  if (timescale <= 0) throw invalid("A track counts no time of its own");
  const stts = find(boxes, "stts");
  const stsz = find(boxes, "stsz");
  const stco = find(boxes, "stco");
  const co64 = find(boxes, "co64");
  if (!stts || !stsz) throw invalid("A track without its sample tables");
  if (!stco && !co64) throw invalid("A track without its chunk offsets");
  const sizes = parseStsz(view, stsz);
  const deltas = parseStts(view, stts);
  const ctts = find(boxes, "ctts");
  const offsets = ctts ? parseCtts(view, ctts) : [];
  const keys = parseStss(view, find(boxes, "stss"), sizes.length);
  const chunks = parseStco(view, (stco ?? co64)!, co64 !== undefined);
  const map = parseStsc(view, find(boxes, "stsc"));

  const samples: Mp4Sample[] = [];
  let dts = 0;
  let placed = 0;
  for (let chunkAt = 1; chunkAt <= chunks.length; chunkAt += 1) {
    // The last map entry that starts at or before this chunk is the one in force.
    let entry = map[0];
    for (const candidate of map)
      if (candidate.firstChunk <= chunkAt) entry = candidate;
    let offset = chunks[chunkAt - 1];
    for (let n = 0; n < entry.samplesPerChunk; n += 1) {
      if (placed >= sizes.length) break;
      const size = sizes[placed];
      const delta = deltas[placed] ?? deltas[deltas.length - 1] ?? 0;
      samples.push({
        offset,
        size,
        dtsUs: toUs(dts, timescale),
        ctsUs: toUs(dts + (offsets[placed] ?? 0), timescale),
        key: keys[placed] ?? false,
      });
      offset += size;
      dts += delta;
      placed += 1;
    }
  }
  return samples;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** How large a moov this preview will take in; past this it is not an index but a payload. */
const MAX_MOOV_BYTES = 16 * 1024 * 1024;

export function parseMoov(bytes: DataView): Mp4Index {
  const moov = readBox(bytes, 0, bytes.byteLength);
  if (moov.type !== "moov") throw invalid("The box is not a moov");
  const boxes = children(bytes, moov);
  if (find(boxes, "mvex"))
    throw new Mp4Error(
      "MOKA_MP4_FRAGMENTED",
      "A fragmented file keeps its samples in moof boxes this preview does not walk",
    );
  const mvhd = find(boxes, "mvhd");
  if (!mvhd) throw invalid("A moov without a movie header");
  const movie = parseMvhd(bytes, mvhd);
  if (movie.timescale <= 0)
    throw invalid("The movie counts no time of its own");

  let video: Mp4VideoTrack | null = null;
  let audio: Mp4AudioTrack | null = null;
  let sawVideo = false;
  for (const trak of boxes.filter((box) => box.type === "trak")) {
    const mdia = inside(bytes, trak, "mdia");
    if (!mdia) continue;
    const hdlr = inside(bytes, mdia, "hdlr");
    const handler = hdlr ? fourcc(bytes, hdlr.start + 8) : "";
    if (handler !== "vide" && handler !== "soun") continue;
    if (handler === "vide") sawVideo = true;
    const mdhd = inside(bytes, mdia, "mdhd");
    const minf = inside(bytes, mdia, "minf");
    const stbl = minf ? inside(bytes, minf, "stbl") : undefined;
    if (!mdhd || !stbl) continue;
    const media = parseMdhd(bytes, mdhd);
    const stblBoxes = children(bytes, stbl);
    const stsd = find(stblBoxes, "stsd");
    if (!stsd) continue;
    const facts = parseStsd(bytes, stsd);
    if (!facts) continue;

    if (handler === "soun") {
      if (audio) continue;
      try {
        audio = {
          codec: facts.codec,
          description: facts.description,
          timescale: media.timescale,
          durationMs: toMs(media.durationTicks, media.timescale),
          sampleRate: facts.sampleRate,
          channels: facts.channels,
          samples: parseSampleTable(bytes, stblBoxes, media.timescale),
        };
      } catch {
        // A sound track whose tables are broken is package 07's to report: it
        // is not allowed to cost the picture its index.
      }
      continue;
    }

    const samples = parseSampleTable(bytes, stblBoxes, media.timescale);
    if (video) continue;
    const tkhd = inside(bytes, trak, "tkhd");
    video = {
      codec: facts.codec,
      description: facts.description,
      rotationDeg: tkhd ? rotationOf(bytes, tkhd) : 0,
      width: facts.width,
      height: facts.height,
      samples,
    };
  }

  const lastCtsMs = video?.samples.length
    ? Math.round(video.samples[video.samples.length - 1].ctsUs / 1_000)
    : 0;
  // A video track whose sample entry this preview cannot name is one the
  // element engine has to be asked about, which the code says rather than the
  // caller finding out later that there is no picture.
  if (sawVideo && !video)
    throw unsupported(
      "The video's sample entry is not one this preview decodes",
    );
  // A duration of all ones is how a file says it does not know; the samples do.
  const durationMs =
    movie.durationTicks >= 0xffff_ffff
      ? lastCtsMs
      : toMs(movie.durationTicks, movie.timescale);

  return {
    timescale: movie.timescale,
    durationMs,
    video,
    audio,
  };
}

/** The moov of a whole file held in memory, walked from the top. */
export function parseFile(bytes: Uint8Array): Mp4Index {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at + 8 <= bytes.byteLength) {
    const box = readBox(view, at, bytes.byteLength);
    if (box.type === "moof")
      throw new Mp4Error(
        "MOKA_MP4_FRAGMENTED",
        "A fragmented file keeps its samples in moof boxes this preview does not walk",
      );
    if (box.type === "moov") {
      const moov = new DataView(
        bytes.buffer,
        bytes.byteOffset + at,
        box.at + box.headerSize + box.size - at,
      );
      return parseMoov(moov);
    }
    at = box.at + box.headerSize + box.size;
  }
  throw invalid("The file has no moov box");
}

/** A window of a file's bytes, with the file's length when the server said it. */
export interface ByteWindow {
  bytes: Uint8Array;
  total: number | null;
}

function contentRangeStart(header: string | null): number | null {
  const range = header?.split(" ")[1]?.split("/")[0];
  if (!range) return null;
  const start = Number(range.split("-")[0]);
  return Number.isFinite(start) ? start : null;
}

function contentRangeTotal(header: string | null): number | null {
  const total = header?.split("/")[1];
  if (!total) return null;
  const value = Number(total);
  return Number.isFinite(value) ? value : null;
}

/**
 * A bounded read: the bytes from `start` to `end` (exclusive), asked for by
 * Range so a preview never pulls a whole file across to look at a frame.
 *
 * The server may answer with the whole file instead — a route that does not
 * know ranges — which is usable only from the first byte, and the walk says so
 * rather than reading someone else's offset as its own.
 */
export async function readRange(
  url: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<ByteWindow> {
  if (end <= start) return { bytes: new Uint8Array(0), total: null };
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${end - 1}` },
    signal,
  });
  if (!response.ok)
    throw invalid(`The file did not answer for its bytes (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const range = response.headers.get("Content-Range");
  if (response.status !== 206) {
    if (start !== 0) throw invalid("The file cannot be read in parts");
    return { bytes, total: bytes.byteLength };
  }
  if (contentRangeStart(range) !== start)
    throw invalid("The file answered from somewhere else");
  return { bytes, total: contentRangeTotal(range) };
}

/** The bytes a box header can take at most: a 32-bit size, a type, and a 64-bit size. */
const HEAD_BYTES = 16;

/** How much of a file one walk window holds: a small file's boxes, moov and all. */
const WALK_WINDOW_BYTES = 64 * 1024;

async function walk(url: string, signal?: AbortSignal): Promise<Mp4Index> {
  let at = 0;
  let total: number | null = null;
  let windowStart = 0;
  let window = new Uint8Array(0);
  for (;;) {
    if (total !== null && at >= total) break;
    // One read covers a stretch of boxes: a header at the window's edge, or a
    // box that jumped past it, is what asks for the next window.
    if (at + HEAD_BYTES > windowStart + window.byteLength) {
      const read = await readRange(url, at, at + WALK_WINDOW_BYTES, signal);
      window = read.bytes;
      windowStart = at;
      total = read.total ?? total;
    }
    const inside = at - windowStart;
    if (window.byteLength - inside < 8) break;
    const head = new DataView(
      window.buffer,
      window.byteOffset + inside,
      window.byteLength - inside,
    );
    let size = u32(head, 0);
    const type = fourcc(head, 4);
    let headerSize = 8;
    if (size === 1) {
      if (window.byteLength - inside < 16)
        throw invalid("A box header is cut short");
      size = u64(head, 8);
      headerSize = 16;
    } else if (size === 0) {
      if (total === null)
        throw invalid("A box runs to the end of a file of unknown length");
      size = total - at;
    }
    if (size < headerSize)
      throw invalid("A box is smaller than its own header");
    if (type === "moof")
      throw new Mp4Error(
        "MOKA_MP4_FRAGMENTED",
        "A fragmented file keeps its samples in moof boxes this preview does not walk",
      );
    if (type === "moov") {
      if (size > MAX_MOOV_BYTES)
        throw invalid("The moov is larger than this preview reads");
      // A moov standing whole in the window is parsed from it; one that runs
      // past the window's edge is read on its own, as it always was.
      const bytes =
        size <= window.byteLength - inside
          ? window.subarray(inside, inside + size)
          : (await readRange(url, at, at + size, signal)).bytes;
      return parseMoov(
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      );
    }
    at += size;
  }
  throw invalid("The file has no moov box");
}

export interface OpenMp4Options {
  /** The asset the index belongs to, which is how the parse is remembered. */
  assetId?: AssetId;
  signal?: AbortSignal;
}

const indexCache = new Map<AssetId, Promise<Mp4Index>>();

/**
 * Opens a file at a URL: its moov is read whole and its samples are left where
 * they are. moov first or last makes no difference — the walk follows the
 * boxes' own sizes — and the result is kept per asset so dragging the playhead
 * parses once.
 */
export async function openMp4(
  url: string,
  options: OpenMp4Options = {},
): Promise<Mp4Index> {
  const { assetId, signal } = options;
  const kept = assetId ? indexCache.get(assetId) : undefined;
  if (kept) return kept;
  const loading = walk(url, signal);
  if (!assetId) return loading;
  indexCache.set(assetId, loading);
  try {
    return await loading;
  } catch (error) {
    // A file that could not be read this time is not a file pinned to that answer.
    indexCache.delete(assetId);
    throw error;
  }
}
