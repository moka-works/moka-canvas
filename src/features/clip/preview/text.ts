import type { TextClipData, TextClipStyle } from "../../../shared/domain";

/**
 * Words on the picture, set the way the exporter will set them.
 *
 * The preview and the burn-in have to agree about where a line lands, so the
 * rules live here in the frame's own terms: sizes and paddings are timeline
 * pixels scaled by the canvas's width, a `\n` is a line break the author asked
 * for, and anything longer than the frame is wrapped at nine tenths of it. The
 * outline is stroked before the fill — the glyph sits on top of its own edge,
 * as it does when 12 hands the same numbers to the subtitle renderer.
 */

/** Where a block of text sits, in canvas pixels. */
export interface TextLayout {
  fontPx: number;
  lineHeightPx: number;
  lines: string[];
  /** The block's left edge: what the alignment lines the lines up against. */
  x: number;
  /** The block's top edge: the first line's baseline of a top-aligned block. */
  y: number;
  width: number;
  height: number;
  paddingPx: number;
  radiusPx: number;
  strokeWidthPx: number;
  align: TextClipStyle["align"];
  /** Extra space between letters, in canvas pixels. */
  letterSpacingPx: number;
  /** Where a turn about the block's own centre is anchored. */
  centerX: number;
  centerY: number;
}

/** The side margin a positioned block keeps, as a share of the frame's height. */
export const TEXT_MARGIN_SHARE = 0.06;
/** The plate's padding and the corner it is rounded by, as shares of the font size. */
export const TEXT_PLATE_PADDING_SHARE = 0.6;
export const TEXT_PLATE_RADIUS_SHARE = 0.25;
/** A line of text takes a quarter more room than its glyphs. */
export const TEXT_LINE_SHARE = 1.25;
/** Text wraps at this share of the frame's width when nobody wrote a newline. */
export const TEXT_WIDTH_SHARE = 0.9;

/** The font shorthand a style is written in at a canvas's scale. */
export function textFont(style: TextClipStyle, scale: number): string {
  const weight = style.bold ? "bold " : "";
  const slant = style.italic ? "italic " : "";
  return `${slant}${weight}${Math.max(1, style.fontSize * scale)}px ${style.fontFamily}`;
}

/**
 * The lines a piece of text is set in: the author's own breaks kept, and
 * anything past the width broken at spaces. A word longer than the frame is
 * left whole rather than cut — it is a word, not a line.
 */
export function wrapLines(
  ctx: CanvasRenderingContext2D,
  content: string,
  maxWidth: number,
  letterSpacingPx = 0,
): string[] {
  const lines: string[] = [];
  for (const paragraph of content.split("\n")) {
    const words = paragraph.split(" ");
    let line = "";
    for (const word of words) {
      const candidate = line.length === 0 ? word : `${line} ${word}`;
      if (
        line.length > 0 &&
        measureLine(ctx, candidate, letterSpacingPx) > maxWidth
      ) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** A line's width with the letter spacing the style asks for. */
function measureLine(
  ctx: CanvasRenderingContext2D,
  line: string,
  letterSpacingPx: number,
): number {
  const glyphs = [...line];
  const width = ctx.measureText(line).width;
  return letterSpacingPx > 0 && glyphs.length > 1
    ? width + letterSpacingPx * (glyphs.length - 1)
    : width;
}

/** Where a text clip's words sit on a frame of this size. */
export function textLayout(
  ctx: CanvasRenderingContext2D,
  data: TextClipData,
  frame: { width: number; height: number },
  timelineWidth: number,
): TextLayout {
  // The canvas may be larger or smaller than the timeline; every size the
  // document states is scaled into the picture being drawn.
  const scale = timelineWidth > 0 ? frame.width / timelineWidth : 1;
  const fontPx = Math.max(1, data.style.fontSize * scale);
  const letterSpacingPx = Math.max(0, data.style.letterSpacing ?? 0) * scale;
  ctx.font = textFont(data.style, scale);
  const lines = wrapLines(
    ctx,
    data.content,
    frame.width * TEXT_WIDTH_SHARE,
    letterSpacingPx,
  );
  const lineHeightPx = fontPx * TEXT_LINE_SHARE;
  const width = lines.reduce(
    (widest, line) => Math.max(widest, measureLine(ctx, line, letterSpacingPx)),
    0,
  );
  const height = Math.max(1, lines.length) * lineHeightPx;
  const margin = frame.height * TEXT_MARGIN_SHARE;
  const freeX = data.style.x;
  const freeY = data.style.y;
  const free = freeX !== undefined && freeY !== undefined;
  const x = free
    ? frame.width * Math.max(0, Math.min(1, freeX ?? 0)) - width / 2
    : data.style.align === "left"
      ? margin
      : data.style.align === "right"
        ? frame.width - margin - width
        : (frame.width - width) / 2;
  const y = free
    ? frame.height * Math.max(0, Math.min(1, freeY ?? 0)) - height / 2
    : data.style.position === "top"
      ? margin
      : data.style.position === "bottom"
        ? frame.height - margin - height
        : (frame.height - height) / 2;
  return {
    fontPx,
    lineHeightPx,
    lines,
    x,
    y,
    width,
    height,
    paddingPx: fontPx * TEXT_PLATE_PADDING_SHARE,
    radiusPx: fontPx * TEXT_PLATE_RADIUS_SHARE,
    strokeWidthPx: data.style.strokeWidth * scale,
    align: data.style.align,
    letterSpacingPx,
    centerX: x + width / 2,
    centerY: y + height / 2,
  };
}

/** Where a line of the block starts, given the block's alignment. */
function lineX(layout: TextLayout): number {
  if (layout.align === "left") return layout.x;
  if (layout.align === "right") return layout.x + layout.width;
  return layout.x + layout.width / 2;
}

/** One line, letters pushed apart by the style's own spacing. */
function drawSpacedLine(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  line: string,
  y: number,
  stroke: boolean,
): void {
  const glyphs = [...line];
  const lineWidth = measureLine(ctx, line, layout.letterSpacingPx);
  let x =
    layout.align === "left"
      ? layout.x
      : layout.align === "right"
        ? layout.x + layout.width - lineWidth
        : layout.x + (layout.width - lineWidth) / 2;
  ctx.textAlign = "left";
  for (const glyph of glyphs) {
    if (stroke) ctx.strokeText(glyph, x, y);
    else ctx.fillText(glyph, x, y);
    x += ctx.measureText(glyph).width + layout.letterSpacingPx;
  }
  ctx.textAlign = layout.align;
}

/** Draws a text clip: its plate, then each line's outline, then the line itself. */
export function drawTextClip(
  ctx: CanvasRenderingContext2D,
  data: TextClipData,
  frame: { width: number; height: number },
  timelineWidth: number,
  alpha: number,
): TextLayout {
  const layout = textLayout(ctx, data, frame, timelineWidth);
  // A clip with no words takes no room: a line of nothing is not a line.
  if (data.content.length === 0) return layout;
  // Whatever the context already carries is part of the words' presence, so a
  // seam blend scales them the same way it scales a picture's clip.
  const carried = ctx.globalAlpha;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha)) * carried;
  ctx.font = textFont(
    data.style,
    timelineWidth > 0 ? frame.width / timelineWidth : 1,
  );
  ctx.textAlign = data.style.align;
  // The layout measures from the block's top edge, so the baseline is the top.
  ctx.textBaseline = "top";
  const rotation = data.style.rotation ?? 0;
  if (rotation !== 0) {
    ctx.translate(layout.centerX, layout.centerY);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.translate(-layout.centerX, -layout.centerY);
  }
  if (data.style.background) {
    ctx.fillStyle = data.style.background;
    ctx.beginPath();
    ctx.roundRect(
      layout.x - layout.paddingPx,
      layout.y - layout.paddingPx,
      layout.width + layout.paddingPx * 2,
      layout.height + layout.paddingPx * 2,
      layout.radiusPx,
    );
    ctx.fill();
  }
  const x = lineX(layout);
  for (let index = 0; index < layout.lines.length; index += 1) {
    const y = layout.y + index * layout.lineHeightPx;
    const line = layout.lines[index];
    const spaced = layout.letterSpacingPx > 0;
    if (layout.strokeWidthPx > 0) {
      ctx.strokeStyle = data.style.strokeColor;
      ctx.lineWidth = layout.strokeWidthPx;
      if (spaced) drawSpacedLine(ctx, layout, line, y, true);
      else ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = data.style.color;
    if (spaced) drawSpacedLine(ctx, layout, line, y, false);
    else ctx.fillText(line, x, y);
  }
  ctx.restore();
  return layout;
}
