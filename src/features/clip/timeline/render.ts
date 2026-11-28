import type {
  AssetId,
  ClipId,
  TimelineClip,
  TimelineDocument,
  TransitionId,
} from "../../../shared/domain";
import { followerOf } from "../../../shared/domain/timeline";
import { materialMoment } from "../preview/compositor";
import type { DraftClip, TimelineDraft } from "../interactions/gestures";
import {
  RULER_H,
  TRANSITION_BADGE_PX,
  clipRect,
  contentHeight,
  msAt,
  tickLadder,
  trackRows,
  transitionCenterX,
  visibleRange,
  xAt,
  type TimelineView,
  type TrackRow,
} from "./geometry";
import { TIMELINE_PALETTE, type TimelinePalette } from "./palette";
import { formatTickLabel, formatTimecode } from "./timecode";
import { bucketAtIndex, downsample, type WaveformPeaks } from "./waveform";

/**
 * A clip's sound as the timeline draws it: the buckets of its material, or the
 * flat line that stands in for a sound this browser will not decode.
 */
export type WaveformDrawing =
  { kind: "peaks"; peaks: WaveformPeaks } | { kind: "flat" };

/**
 * What a block is drawn with beyond its own colour: a sound's shape and a
 * picture's first frame, both arriving from 07's provider and never waited on.
 */
export interface TimelineDecor {
  /** The sound a clip's block wears, or null while it is still being measured. */
  waveform(clip: TimelineClip): WaveformDrawing | null;
  /** The picture an asset's block wears, or null until one has been made. */
  thumb(assetId: AssetId): CanvasImageSource | null;
}

export interface TimelineRenderModel {
  timeline: TimelineDocument;
  view: TimelineView;
  /** The visible screen: what the drawing is culled to, vertical scroll included. */
  viewport: { width: number; height: number; scrollTopPx: number };
  playheadMs: number;
  selection: { clipIds: readonly ClipId[]; transitionId: TransitionId | null };
  /** The drawing's decoration; null until 07's provider is there. */
  decor: TimelineDecor | null;
  /**
   * What a gesture is drawing: blocks where a drag or a trim would leave
   * them, the guide a snapped edge landed on, and the rectangle of a marquee.
   *
   * The canvas hands in whatever its pointer session holds at draw time, so
   * the draft is read fresh every frame and never lives in a store.
   */
  draft?: TimelineDraft | null;
  /**
   * The butted seam the pointer is over, as the canvas read it: the ghost `+`
   * is drawn for exactly this seam and nothing else. A hover is a reading of
   * the pointer, not a fact about the cut, so it lives in the canvas's own
   * state and never in a store.
   */
  hoverSeam?: { leader: TimelineClip; follower: TimelineClip } | null;
  palette?: TimelinePalette;
}

const CLIP_FONT = "12px ui-sans-serif, system-ui, sans-serif";
const BADGE_FONT = "10px ui-sans-serif, system-ui, sans-serif";
const CLIP_RADIUS = 6;
const MARKER_TINTS: Record<string, string> = {
  white: "#f4f4f6",
  yellow: "#f2ce7a",
  green: "#7ad9a8",
  blue: "#7aa8f2",
  purple: "#b58af2",
  red: "#ff8a80",
};
/** How far apart a video block's pictures sit; one thumbnail's own width. */
const FILMSTRIP_STEP_PX = 96;
/** The `+` a hovered seam offers, square. */
const SEAM_GHOST_PX = 16;

/**
 * A whole screen of timeline: rows, clips, seams, the ruler and the playhead.
 *
 * Called once per frame with no state of its own, so what is drawn is always
 * what the model says. Everything outside the viewport is culled before it is
 * painted — at the tightest zoom the content is wider than any canvas a
 * browser will hand out, and a screenful is all anyone can see anyway.
 */
export function renderTimeline(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
): void {
  const palette = model.palette ?? TIMELINE_PALETTE;
  const { width, height, scrollTopPx } = model.viewport;
  ctx.fillStyle = palette.canvas;
  ctx.fillRect(0, 0, width, height);

  const rulerY = -scrollTopPx;
  // Rows are drawn for whatever tracks the timeline has, clips on them or
  // not: the header beside them reads out those tracks, and an empty row is
  // where the first piece will land. Only a timeline with no tracks at all is
  // a ruler over the background.
  const rows = trackRows(model.timeline);
  if (rows.length > 0) {
    drawRows(ctx, model, rows, palette);
    drawGrid(ctx, model, rows, palette);
    if (model.timeline.clips.length > 0) {
      drawClips(ctx, model, rows, palette);
      drawTransitions(ctx, model, rows, palette);
      // The hover is drawn over the badges but under the draft: it is an
      // offer, while a draft is a gesture already in hand.
      drawSeamGhost(ctx, model, rows, palette);
    }
  }
  drawDraft(ctx, model, rows, palette);
  drawRange(ctx, model, rows, palette, rulerY);
  drawRuler(ctx, model, palette, rulerY);
  drawMarkers(ctx, model, palette, rulerY);
  drawPlayhead(ctx, model, palette, rulerY);
}

function drawRange(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  rows: TrackRow[],
  palette: TimelinePalette,
  rulerY: number,
): void {
  const { inPointMs, outPointMs } = model.timeline;
  if (inPointMs == null && outPointMs == null) return;
  const { width, height, scrollTopPx } = model.viewport;
  const top = Math.max(rulerY, (rows[0]?.top ?? rulerY) - scrollTopPx);
  const bottom = Math.min(height, contentHeight(model.timeline) - scrollTopPx);
  if (inPointMs != null && outPointMs != null) {
    const start = xAt(inPointMs, model.view);
    const end = xAt(outPointMs, model.view);
    ctx.fillStyle = palette.rangeDim;
    ctx.fillRect(0, top, Math.max(0, start), Math.max(0, bottom - top));
    ctx.fillRect(
      Math.min(width, end),
      top,
      Math.max(0, width - end),
      Math.max(0, bottom - top),
    );
  }
  ctx.strokeStyle = palette.ink;
  ctx.lineWidth = 1;
  if (inPointMs != null) {
    const x = xAt(inPointMs, model.view);
    ctx.beginPath();
    ctx.moveTo(x, rulerY);
    ctx.lineTo(x, bottom);
    ctx.moveTo(x, rulerY + 4);
    ctx.lineTo(x + 6, rulerY + 4);
    ctx.stroke();
  }
  if (outPointMs != null) {
    const x = xAt(outPointMs, model.view);
    ctx.beginPath();
    ctx.moveTo(x, rulerY);
    ctx.lineTo(x, bottom);
    ctx.moveTo(x, rulerY + 4);
    ctx.lineTo(x - 6, rulerY + 4);
    ctx.stroke();
  }
}

function drawMarkers(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  palette: TimelinePalette,
  rulerY: number,
): void {
  const markers = model.timeline.markers ?? [];
  if (markers.length === 0) return;
  const { width } = model.viewport;
  ctx.font = BADGE_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const marker of markers) {
    const x = xAt(marker.atMs, model.view);
    if (x < -40 || x > width + 40) continue;
    ctx.fillStyle = MARKER_TINTS[marker.color] ?? MARKER_TINTS.white;
    ctx.fillRect(x, rulerY + 3, 8, 8);
    ctx.fillStyle = palette.label;
    ctx.fillText(marker.label.slice(0, 16), x + 11, rulerY + 7);
  }
}

function drawRows(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  rows: TrackRow[],
  palette: TimelinePalette,
): void {
  const { width, height, scrollTopPx } = model.viewport;
  rows.forEach((row, index) => {
    const y = row.top - scrollTopPx;
    if (y > height || y + row.height < 0) return;
    ctx.fillStyle = index % 2 === 0 ? palette.rowA : palette.rowB;
    // A hidden track still shows through, washed out: it is why the picture
    // is missing, not a row that has gone.
    ctx.globalAlpha = row.track.hidden ? 0.45 : 1;
    ctx.fillRect(0, y, width, row.height);
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.rowLine;
    ctx.fillRect(0, y + row.height - 1, width, 1);
    if (row.track.locked) drawLockMark(ctx, 8, y + row.height / 2, palette);
  });
}

function drawLockMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  centreY: number,
  palette: TimelinePalette,
): void {
  ctx.strokeStyle = palette.lock;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(x, centreY - 1, 8, 6.5, 1.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + 4, centreY - 1, 2.6, Math.PI, 0);
  ctx.stroke();
}

/** The major ticks drop a faint line through the rows, tying ruler to content. */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  rows: TrackRow[],
  palette: TimelinePalette,
): void {
  const { width, height, scrollTopPx } = model.viewport;
  const ladder = tickLadder(model.timeline.settings.fps, model.view.pxPerSec);
  const { endMs } = visibleRange(model.view, width);
  const top = Math.max(0, rows[0].top - scrollTopPx);
  const bottom = Math.min(height, contentHeight(model.timeline) - scrollTopPx);
  if (bottom <= top) return;
  ctx.fillStyle = palette.grid;
  for (let i = 1; i * ladder.majorMs <= endMs; i += 1) {
    const x = xAt(i * ladder.majorMs, model.view);
    if (x < 0 || x > width) continue;
    ctx.fillRect(x, top, 1, bottom - top);
  }
}

function drawRuler(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  palette: TimelinePalette,
  rulerY: number,
): void {
  const { width } = model.viewport;
  ctx.fillStyle = palette.ruler;
  ctx.fillRect(0, rulerY, width, RULER_H);
  ctx.fillStyle = palette.rulerLine;
  ctx.fillRect(0, rulerY + RULER_H - 1, width, 1);

  const fps = model.timeline.settings.fps;
  const ladder = tickLadder(fps, model.view.pxPerSec);
  const { endMs } = visibleRange(model.view, width);
  const step = ladder.minorMs ?? ladder.majorMs;
  ctx.font = BADGE_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (let i = 0; i * step <= endMs; i += 1) {
    const ms = i * step;
    const x = xAt(ms, model.view);
    if (x < 0 || x > width) continue;
    const major = isMultipleOf(ms, ladder.majorMs);
    const tickH = major ? 8 : 4;
    ctx.fillStyle = major ? palette.tick : palette.tickMinor;
    ctx.fillRect(x, rulerY + RULER_H - tickH, 1, tickH);
    ctx.fillStyle = palette.label;
    ctx.fillText(formatTickLabel(ms, fps), x + 4, rulerY + 10);
  }
}

function isMultipleOf(ms: number, step: number): boolean {
  const ratio = ms / step;
  return Math.abs(ratio - Math.round(ratio)) < 1e-6;
}

function drawClips(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  rows: TrackRow[],
  palette: TimelinePalette,
): void {
  const { width, height, scrollTopPx } = model.viewport;
  for (const row of rows) {
    const rowY = row.top - scrollTopPx;
    if (rowY > height || rowY + row.height < 0) continue;
    // Sorted by where they start, which is also the order they overlap in:
    // the follower of a seam draws over the tail it was pulled back into.
    const draft = model.draft?.kind === "fade" ? model.draft.clip : null;
    const onTrack = model.timeline.clips
      .filter((clip) => clip.trackId === row.track.id)
      .map((clip) => (draft?.id === clip.id ? draft : clip))
      .sort((a, b) => a.startMs - b.startMs);
    for (const clip of onTrack) {
      const rect = { ...clipRect(clip, rows, model.view), y: rowY };
      if (rect.x + rect.width < 0 || rect.x > width) continue;
      ctx.save();
      ctx.globalAlpha = row.track.hidden ? 0.45 : 1;
      drawClip(ctx, clip, rect, model, palette);
      ctx.restore();
    }
  }
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  clip: TimelineClip,
  rect: { x: number; y: number; width: number; height: number },
  model: TimelineRenderModel,
  palette: TimelinePalette,
): void {
  const selected = model.selection.clipIds.includes(clip.id);
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y + 0.5, rect.width, rect.height - 1, CLIP_RADIUS);
  ctx.fillStyle = palette.clip[clip.kind];
  ctx.fill();
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeStyle = selected ? palette.selection : palette.clipStroke;
  if (selected) {
    ctx.shadowColor = palette.selectionGlow;
    ctx.shadowBlur = 8;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  if (rect.width < 8) return;
  drawFades(ctx, clip, rect, model, palette);

  if (clip.kind === "audio") {
    // A sound wears its own shape, read by the material's clock.
    drawWaveform(ctx, clip, rect, model, palette);
  } else if (clip.kind === "video") {
    const thumb = thumbOf(clip, model);
    if (thumb && rect.height >= 26) {
      drawFilmstrip(ctx, thumb, rect);
    }
  }
  if (clip.kind === "text") drawTextMark(ctx, rect, palette);

  drawLabel(ctx, clip, rect, palette);
  if (clip.speed !== 1) drawSpeedBadge(ctx, clip, rect, palette);
}

function thumbOf(
  clip: TimelineClip,
  model: TimelineRenderModel,
): CanvasImageSource | null {
  if (!clip.assetId || !model.decor) return null;
  return model.decor.thumb(clip.assetId);
}

/** The pictures a video block wears: one first frame, laid down along the block. */
function drawFilmstrip(
  ctx: CanvasRenderingContext2D,
  thumb: CanvasImageSource,
  rect: { x: number; y: number; width: number; height: number },
): void {
  const imageHeight = rect.height - 10;
  const imageWidth = (imageHeight * 16) / 9;
  if (imageWidth <= 0) return;
  ctx.save();
  // Clipped to the block's own corners, a pixel in so the stroke stays on top.
  ctx.beginPath();
  ctx.roundRect(rect.x + 1, rect.y + 5, rect.width - 2, imageHeight, 4);
  ctx.clip();
  for (
    let x = rect.x + 5;
    x < rect.x + rect.width - 4;
    x += FILMSTRIP_STEP_PX
  ) {
    ctx.drawImage(thumb, x, rect.y + 5, imageWidth, imageHeight);
  }
  ctx.restore();
}

/** The vertical min/max spans a sound's block is drawn with. */
function drawWaveform(
  ctx: CanvasRenderingContext2D,
  clip: TimelineClip,
  rect: { x: number; y: number; width: number; height: number },
  model: TimelineRenderModel,
  palette: TimelinePalette,
): void {
  const drawing = model.decor?.waveform(clip) ?? null;
  if (!drawing) return;
  // Only the columns the screen shows: a long block is wider than any canvas,
  // and the material's clock is what says which part of the file each shows.
  const from = Math.max(rect.x, 0);
  const to = Math.min(rect.x + rect.width, model.viewport.width);
  const visibleWidth = to - from;
  if (visibleWidth < 1) return;
  const columns = Math.max(1, Math.floor(visibleWidth));
  const centre = rect.y + rect.height / 2;
  const half = Math.max(1, rect.height / 2 - 6);
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  if (drawing.kind === "flat") {
    // A sound that would not decode is a flat line at the block's own level:
    // a picture of a sound, not a report of a failure.
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = palette.waveform;
    ctx.fillRect(from, centre - 1, visibleWidth, 2);
    ctx.restore();
    return;
  }
  const peaks = drawing.peaks;
  // The block starts at the material moment its left edge reads and ends at
  // the moment its right edge reads — the block's own range, not the file's.
  const firstBucket = bucketAtIndex(
    peaks,
    materialMoment(clip, msAt(from, model.view)),
  );
  const lastBucket =
    bucketAtIndex(peaks, materialMoment(clip, msAt(to, model.view))) + 1;
  const { min, max } = downsample(peaks, columns, {
    from: firstBucket,
    to: lastBucket,
  });
  ctx.fillStyle = palette.waveform;
  for (let column = 0; column < columns; column += 1) {
    const low = centre - max[column] * half;
    const high = centre - min[column] * half;
    ctx.fillRect(from + column, low, 1, Math.max(1, high - low));
  }
  ctx.restore();
}

/** The clip's name over whatever the block is wearing. */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  clip: TimelineClip,
  rect: { x: number; y: number; width: number; height: number },
  palette: TimelinePalette,
): void {
  const left = clip.kind === "text" ? rect.x + 24 : rect.x + 8;
  const labelWidth = rect.x + rect.width - 8 - left;
  if (labelWidth < 8) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.font = CLIP_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const text = fitLabel(ctx, clipName(clip), labelWidth);
  if (clip.kind !== "text") {
    // Pictures and waveform spans would eat the words: the label sits on a
    // small plate of the block's own colour.
    ctx.globalAlpha = 0.72;
    ctx.fillStyle = palette.clip[clip.kind];
    ctx.beginPath();
    ctx.roundRect(
      left - 4,
      rect.y + 4,
      Math.min(ctx.measureText(text).width + 12, rect.width - 8),
      Math.min(20, rect.height - 8),
      4,
    );
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = palette.ink;
  ctx.fillText(text, left, rect.y + 6);
  ctx.restore();
}

function clipName(clip: TimelineClip): string {
  if (clip.kind === "text" && clip.text) {
    const first = clip.text.content.split("\n")[0].trim();
    if (first.length > 0) return first;
  }
  return clip.label;
}

/** Text over a clip is cut to the room it has; a word that does not fit is shown by its beginning. */
function fitLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/** The two fades are read-only ramps in a clip's corners; 08 and 09 move the lengths. */
function drawFades(
  ctx: CanvasRenderingContext2D,
  clip: TimelineClip,
  rect: { x: number; y: number; width: number; height: number },
  model: TimelineRenderModel,
  palette: TimelinePalette,
): void {
  const pxPerMs = model.view.pxPerSec / 1_000;
  if (clip.fadeInMs > 0) {
    drawFade(ctx, rect, clip.fadeInMs * pxPerMs, "in", palette);
  }
  if (clip.fadeOutMs > 0) {
    drawFade(ctx, rect, clip.fadeOutMs * pxPerMs, "out", palette);
  }
}

function drawFade(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  width: number,
  side: "in" | "out",
  palette: TimelinePalette,
): void {
  const ramp = Math.min(width, rect.width);
  if (ramp <= 0) return;
  ctx.fillStyle = palette.fade;
  ctx.beginPath();
  if (side === "in") {
    ctx.moveTo(rect.x, rect.y);
    ctx.lineTo(rect.x + ramp, rect.y);
    ctx.lineTo(rect.x, rect.y + rect.height);
  } else {
    ctx.moveTo(rect.x + rect.width, rect.y);
    ctx.lineTo(rect.x + rect.width - ramp, rect.y);
    ctx.lineTo(rect.x + rect.width, rect.y + rect.height);
  }
  ctx.closePath();
  ctx.fill();
}

/** The T a text clip leads with, in place of the picture a media clip would show. */
function drawTextMark(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; height: number },
  palette: TimelinePalette,
): void {
  const x = rect.x + 13;
  const y = rect.y + rect.height / 2;
  ctx.strokeStyle = palette.ink;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x - 4.5, y - 5);
  ctx.lineTo(x + 4.5, y - 5);
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y + 5);
  ctx.stroke();
}

function drawSpeedBadge(
  ctx: CanvasRenderingContext2D,
  clip: TimelineClip,
  rect: { x: number; y: number; width: number; height: number },
  palette: TimelinePalette,
): void {
  ctx.font = BADGE_FONT;
  const text = `${clip.speed}×`;
  const badgeW = ctx.measureText(text).width + 9;
  const badgeH = 14;
  if (rect.width < badgeW + 10) return;
  const x = rect.x + 5;
  const y = rect.y + rect.height - badgeH - 5;
  ctx.beginPath();
  ctx.roundRect(x, y, badgeW, badgeH, 4);
  ctx.fillStyle = palette.speedFill;
  ctx.fill();
  ctx.fillStyle = palette.ink;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 4.5, y + badgeH / 2);
}

/**
 * The seam badges, over the clips they join.
 *
 * The glyph is the two overlapped triangles every crossfade wears; the kinds
 * that will want glyphs of their own are 10's business.
 */
function drawTransitions(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  rows: TrackRow[],
  palette: TimelinePalette,
): void {
  const { width, height, scrollTopPx } = model.viewport;
  const half = TRANSITION_BADGE_PX / 2;
  for (const transition of model.timeline.transitions) {
    const centreX = transitionCenterX(
      transition,
      model.timeline.clips,
      model.view,
    );
    if (centreX === null) continue;
    const leader = model.timeline.clips.find(
      (clip) => clip.id === transition.afterClipId,
    );
    if (!leader) continue;
    const row = rows.find((candidate) => candidate.track.id === leader.trackId);
    if (!row) continue;
    const centreY = row.top + row.height / 2 - scrollTopPx;
    if (centreX < -half || centreX > width + half) continue;
    if (centreY < -half || centreY > height + half) continue;
    drawSeamBadge(
      ctx,
      centreX,
      centreY,
      model.selection.transitionId === transition.id,
      palette,
    );
  }
}

/** One seam's badge: the plate, its stroke, and the crossfade glyph. */
function drawSeamBadge(
  ctx: CanvasRenderingContext2D,
  centreX: number,
  centreY: number,
  selected: boolean,
  palette: TimelinePalette,
): void {
  const half = TRANSITION_BADGE_PX / 2;
  ctx.beginPath();
  ctx.roundRect(
    centreX - half,
    centreY - half,
    TRANSITION_BADGE_PX,
    TRANSITION_BADGE_PX,
    5,
  );
  ctx.fillStyle = palette.badgeFill;
  ctx.fill();
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeStyle = selected ? palette.selection : palette.badgeStroke;
  ctx.stroke();
  ctx.strokeStyle = palette.badgeGlyph;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(centreX - 5, centreY - 3.5);
  ctx.lineTo(centreX + 0.5, centreY);
  ctx.lineTo(centreX - 5, centreY + 3.5);
  ctx.moveTo(centreX + 5, centreY - 3.5);
  ctx.lineTo(centreX - 0.5, centreY);
  ctx.lineTo(centreX + 5, centreY + 3.5);
  ctx.stroke();
}

/**
 * The `+` a butted seam offers under the pointer.
 *
 * Drawn only for the seam the canvas has hovered, and only while that seam is
 * still butted in the document being drawn — a `+` under a pointer that no
 * longer sits on an empty seam would be an offer the room cannot keep.
 */
function drawSeamGhost(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  rows: TrackRow[],
  palette: TimelinePalette,
): void {
  const hover = model.hoverSeam;
  if (!hover) return;
  const leader = model.timeline.clips.find(
    (clip) => clip.id === hover.leader.id,
  );
  const follower = model.timeline.clips.find(
    (clip) => clip.id === hover.follower.id,
  );
  if (
    !leader ||
    !follower ||
    follower.startMs !== leader.startMs + leader.durationMs
  )
    return;
  const row = rows.find((candidate) => candidate.track.id === leader.trackId);
  if (!row) return;
  const { width, height, scrollTopPx } = model.viewport;
  const x = xAt(follower.startMs, model.view);
  const y = row.top + row.height / 2 - scrollTopPx;
  const half = SEAM_GHOST_PX / 2;
  if (x < -half || x > width + half) return;
  if (y < -half || y > height + half) return;
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.roundRect(
    x - half,
    y - half,
    SEAM_GHOST_PX,
    SEAM_GHOST_PX,
    SEAM_GHOST_PX / 4,
  );
  ctx.fillStyle = palette.badgeFill;
  ctx.fill();
  ctx.strokeStyle = palette.selection;
  ctx.lineWidth = 1;
  ctx.stroke();
  // The plus itself, drawn rather than set in type so it stays legible at
  // whatever the device's pixel ratio is.
  ctx.strokeStyle = palette.ink;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x - 3.5, y);
  ctx.lineTo(x + 3.5, y);
  ctx.moveTo(x, y - 3.5);
  ctx.lineTo(x, y + 3.5);
  ctx.stroke();
  ctx.restore();
}

/**
 * What a gesture has in hand, drawn over the cut but under the ruler.
 *
 * Above the blocks, so a ghost is not hidden by the piece it would replace,
 * and below the playhead, so the clock stays readable while blocks are
 * dragged onto it. Nothing here is a document: a frame that loses the draft
 * draws the cut exactly as it stands.
 */
function drawDraft(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  rows: TrackRow[],
  palette: TimelinePalette,
): void {
  const draft = model.draft;
  if (!draft || rows.length === 0) return;
  if (draft.kind === "marquee") {
    drawMarquee(ctx, model, draft.rect, palette);
    return;
  }
  if (draft.kind === "seam") {
    drawSeamDraft(ctx, model, rows, draft, palette);
    return;
  }
  if (draft.kind === "drop") {
    // The block a release would lay down, drawn from the very arithmetic the
    // drop lands through: where it would sit, how long it would run, and the
    // moment its head was caught on. A ghost over a piece already there draws
    // the overlap the reader is about to ask for, which is the one thing a
    // drop's own words could only say after the fact.
    drawGhost(ctx, model, rows, draft.clip, palette, draft.conflict !== null);
    if (draft.guideMs !== null)
      drawGuide(ctx, model, rows, draft.guideMs, [draft.clip], palette);
    drawDurationBubble(
      ctx,
      model,
      draft.clip.trackId,
      draft.clip.startMs + draft.clip.durationMs / 2,
      draft.clip.durationMs,
      palette,
    );
    return;
  }
  if (draft.kind === "fade") {
    const row = rows.find((each) => each.track.id === draft.clip.trackId);
    if (!row) return;
    const y = row.top - model.viewport.scrollTopPx;
    const x = xAt(
      draft.edge === "in"
        ? draft.clip.startMs + draft.clip.fadeInMs
        : draft.clip.startMs + draft.clip.durationMs - draft.clip.fadeOutMs,
      model.view,
    );
    ctx.strokeStyle = palette.ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + row.height);
    ctx.stroke();
    ctx.fillStyle = palette.ink;
    ctx.beginPath();
    ctx.arc(x, y + 7, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = BADGE_FONT;
    ctx.fillStyle = palette.ink;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`${draft.valueMs}ms`, x + 7, y + 7);
    return;
  }
  if (draft.kind === "move" && draft.rowTrackId !== null) {
    // The row the group is landing on is lit from underneath: the one piece
    // of feedback a cross-track drag needs, and the reason a refused row
    // stays dark rather than the ghost jumping back without a word.
    const row = rows.find((each) => each.track.id === draft.rowTrackId);
    if (row) {
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = palette.snap;
      ctx.fillRect(
        0,
        row.top - model.viewport.scrollTopPx,
        model.viewport.width,
        row.height,
      );
      ctx.globalAlpha = 1;
    }
  }
  const ghosts = draft.kind === "move" ? draft.clips : [draft.clip];
  for (const ghost of ghosts) drawGhost(ctx, model, rows, ghost, palette);
  if (draft.guideMs !== null)
    drawGuide(ctx, model, rows, draft.guideMs, ghosts, palette);
  if (draft.kind === "trim")
    drawDurationBubble(
      ctx,
      model,
      draft.clip.trackId,
      draft.edge === "start"
        ? draft.clip.startMs
        : draft.clip.startMs + draft.clip.durationMs,
      draft.clip.durationMs,
      palette,
    );
}

/**
 * The window a seam drag would open, drawn before it is a command.
 *
 * The overlay is the overlap the release would leave — from the seam's tail
 * back by the draft's length — with the badge at the seam it will keep and
 * the length read out on the document's clock. Nothing here is a document:
 * the follower moves when the command lands, not while the pointer is down.
 */
function drawSeamDraft(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  rows: TrackRow[],
  draft: { transitionId: TransitionId; durationMs: number },
  palette: TimelinePalette,
): void {
  const transition = model.timeline.transitions.find(
    (each) => each.id === draft.transitionId,
  );
  if (!transition) return;
  const leader = model.timeline.clips.find(
    (clip) => clip.id === transition.afterClipId,
  );
  if (!leader) return;
  const follower = followerOf(model.timeline, leader);
  if (!follower) return;
  const row = rows.find((each) => each.track.id === leader.trackId);
  if (!row) return;
  const { width, height, scrollTopPx } = model.viewport;
  const y = row.top - scrollTopPx;
  if (y > height || y + row.height < 0) return;
  const seamMs = leader.startMs + leader.durationMs;
  const startMs = seamMs - draft.durationMs;
  const x = xAt(startMs, model.view);
  const w = (draft.durationMs / 1_000) * model.view.pxPerSec;
  if (x + w < 0 || x > width) return;
  // The overlap the window would hold, washed across the row's middle so the
  // blocks' own edges stay readable underneath it.
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = palette.selection;
  ctx.beginPath();
  ctx.roundRect(x, y + 3, w, row.height - 6, 4);
  ctx.fill();
  ctx.restore();
  const centreY = y + row.height / 2;
  if (
    centreY >= -TRANSITION_BADGE_PX &&
    centreY <= height + TRANSITION_BADGE_PX
  )
    drawSeamBadge(ctx, xAt(seamMs, model.view), centreY, true, palette);
  drawDurationBubble(
    ctx,
    model,
    leader.trackId,
    seamMs,
    draft.durationMs,
    palette,
  );
}

/** The rectangle a marquee covers, in content space, washed and outlined. */
function drawMarquee(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  rect: { x: number; y: number; width: number; height: number },
  palette: TimelinePalette,
): void {
  // A drag that never leaves its row is still a marquee: the rectangle the
  // selection reads has no height, and the one drawn keeps a line's worth so
  // the reader sees what they are sweeping.
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const y = rect.y - model.viewport.scrollTopPx;
  ctx.fillStyle = palette.marqueeFill;
  ctx.fillRect(rect.x, y, width, height);
  ctx.beginPath();
  ctx.rect(rect.x, y, width, height);
  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.selection;
  ctx.stroke();
}

/** A block where a gesture would leave it: the block's own colour, outlined. */
function drawGhost(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  rows: TrackRow[],
  ghost: DraftClip,
  palette: TimelinePalette,
  blocked = false,
): void {
  const row = rows.find((each) => each.track.id === ghost.trackId);
  if (!row) return;
  const { width, height, scrollTopPx } = model.viewport;
  const y = row.top - scrollTopPx;
  if (y > height || y + row.height < 0) return;
  const x = xAt(ghost.startMs, model.view);
  const w = (ghost.durationMs / 1_000) * model.view.pxPerSec;
  if (x + w < 0 || x > width) return;
  ctx.save();
  ctx.globalAlpha = blocked ? 0.18 : 0.45;
  ctx.beginPath();
  ctx.roundRect(x, y + 0.5, w, row.height - 1, CLIP_RADIUS);
  ctx.fillStyle = blocked ? palette.refuse : palette.clip[ghost.kind];
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.setLineDash([5, 3]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = blocked ? palette.refuse : palette.snap;
  ctx.stroke();
  ctx.restore();
}

/**
 * The guide a snapped edge landed on: a line through the rows and a mark on
 * the edge that caught, so the reader can see which of a block's two edges
 * is doing the catching.
 */
function drawGuide(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  rows: TrackRow[],
  ms: number,
  ghosts: readonly DraftClip[],
  palette: TimelinePalette,
): void {
  const { width, height, scrollTopPx } = model.viewport;
  const x = xAt(ms, model.view);
  if (x < -1 || x > width + 1) return;
  const top = Math.max(0, rows[0].top - scrollTopPx);
  const bottom = Math.min(height, contentHeight(model.timeline) - scrollTopPx);
  if (bottom <= top) return;
  ctx.fillStyle = palette.snap;
  ctx.fillRect(x - 0.5, top, 1, bottom - top);
  for (const ghost of ghosts) {
    const row = rows.find((each) => each.track.id === ghost.trackId);
    if (!row) continue;
    const y = row.top - scrollTopPx;
    const centre = y + row.height / 2;
    if (centre < 0 || centre > height) continue;
    for (const edge of [ghost.startMs, ghost.startMs + ghost.durationMs]) {
      if (Math.abs(edge - ms) > 0.5) continue;
      ctx.fillRect(x - 5, centre - 1.5, 10, 3);
    }
  }
}

/**
 * How long the thing being dragged would run, read as the clock does.
 *
 * One bubble for the trim's new length, one for the seam's new window, and
 * one for the block a drop would lay down: `ms` is the moment the bubble
 * centres on — a trimmed edge's own place, the seam the window will keep, or
 * the middle of the block about to land — and `durationMs` is what it reads
 * out.
 */
function drawDurationBubble(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  trackId: TrackRow["track"]["id"],
  ms: number,
  durationMs: number,
  palette: TimelinePalette,
): void {
  const row = trackRows(model.timeline).find(
    (each) => each.track.id === trackId,
  );
  if (!row) return;
  const { width, height, scrollTopPx } = model.viewport;
  const y = row.top - scrollTopPx;
  if (y > height || y + row.height < 0) return;
  const text = formatTimecode(durationMs, model.timeline.settings.fps);
  ctx.font = BADGE_FONT;
  const w = ctx.measureText(text).width + 12;
  const h = 16;
  const edge = xAt(ms, model.view);
  // Over the block, or under it when the ruler is in the way.
  const top = y - h - 4 >= 0 ? y - h - 4 : y + row.height + 4;
  const left = Math.min(Math.max(edge - w / 2, 2), width - w - 2);
  ctx.beginPath();
  ctx.roundRect(left, top, w, h, 4);
  ctx.fillStyle = palette.badgeFill;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.snap;
  ctx.stroke();
  ctx.fillStyle = palette.ink;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, left + w / 2, top + h / 2 + 0.5);
}

function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  palette: TimelinePalette,
  rulerY: number,
): void {
  const { width, height } = model.viewport;
  const x = xAt(model.playheadMs, model.view);
  if (x < -1 || x > width + 1) return;
  ctx.fillStyle = palette.playhead;
  ctx.fillRect(x - 0.75, rulerY, 1.5, height - rulerY);
  ctx.beginPath();
  ctx.moveTo(x - 4, rulerY + RULER_H - 6);
  ctx.lineTo(x + 4, rulerY + RULER_H - 6);
  ctx.lineTo(x, rulerY + RULER_H);
  ctx.closePath();
  ctx.fill();
}
