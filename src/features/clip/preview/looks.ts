import type {
  ClipAdjust,
  ClipFilterPreset,
  TimelineClip,
} from "../../../shared/domain";

/**
 * The colours a clip wears, as the canvas can draw them.
 *
 * The preview has no grade to run elsewhere: `ctx.filter` is what the browser
 * gives, and it is close enough to what the exporter's own chain will do that
 * the two read as the same look. Each adjustment is a fraction of the range the
 * picture allows, so a quarter is a quarter on both sides, and the presets that
 * are a cast rather than a curve — warm and cool — are a translucent veil
 * blended with soft-light, which is the canvas's honest way of saying the same.
 *
 * Package 12's ffmpeg mapping is this table read in another language.
 */

/** A colour wash a preset lays over the picture. */
export interface LookVeil {
  color: string;
  alpha: number;
}

export interface Look {
  /** What the canvas filter is set to; empty when there is nothing to do. */
  filter: string;
  /** Colour washes laid over the picture, in the order the grade asks. */
  veils: LookVeil[];
}

/** How far below a fraction an adjustment is taken to be a nudge not worth drawing. */
const ADJUST_FLOOR = 0.005;

function amount(value: number): string {
  // Rounded so a slider's float tail never reaches the canvas as a filter string.
  return String(Math.round(value * 100) / 100);
}

/** Brightness, contrast and saturation as one filter, empty when untouched. */
export function adjustFilter(adjust: ClipAdjust | undefined): string {
  if (!adjust) return "";
  const parts: string[] = [];
  if (Math.abs(adjust.brightness) > ADJUST_FLOOR)
    parts.push(`brightness(${amount(1 + adjust.brightness)})`);
  if (Math.abs(adjust.contrast) > ADJUST_FLOOR)
    parts.push(`contrast(${amount(1 + adjust.contrast)})`);
  if (Math.abs(adjust.saturation) > ADJUST_FLOOR)
    parts.push(`saturate(${amount(1 + adjust.saturation)})`);
  return parts.join(" ");
}

/** The preset's filter, for the presets a filter can carry. */
export function presetFilter(preset: ClipFilterPreset | undefined): string {
  switch (preset) {
    case "mono":
      return "grayscale(1)";
    case "fade":
      return "saturate(0.75) contrast(0.92) brightness(1.08)";
    case "vivid":
      return "saturate(1.5) contrast(1.12)";
    default:
      // Warm, cool and none have no curve of their own.
      return "";
  }
}

/** The preset's veil, for the two presets that are a cast rather than a curve. */
export function presetVeil(
  preset: ClipFilterPreset | undefined,
): LookVeil | null {
  if (preset === "warm") return { color: "#ff8a3d", alpha: 0.22 };
  if (preset === "cool") return { color: "#3d8aff", alpha: 0.22 };
  return null;
}

/**
 * White balance as a wash, because the canvas has no temperature control.
 *
 * The exporter moves the channels themselves; the preview splits the cast in
 * two — warm against cool, green against magenta — and blends each at the
 * strength the axis asks for. Two washes rather than one mixed colour keeps a
 * green-tinted cool clip green and cool instead of averaging it to grey.
 */
export function whiteBalanceVeils(adjust: ClipAdjust | undefined): LookVeil[] {
  if (!adjust) return [];
  const veils: LookVeil[] = [];
  const temperature = adjust.temperature ?? 0;
  if (Math.abs(temperature) > ADJUST_FLOOR) {
    veils.push({
      color: temperature > 0 ? "#ff9a4d" : "#4d9aff",
      alpha: 0.25 * Math.abs(temperature),
    });
  }
  const tint = adjust.tint ?? 0;
  if (Math.abs(tint) > ADJUST_FLOOR) {
    veils.push({
      color: tint > 0 ? "#ff5ad1" : "#5aff8a",
      alpha: 0.2 * Math.abs(tint),
    });
  }
  return veils;
}

/** Everything a clip's grade asks for, in one reading. */
export function clipLook(clip: Pick<TimelineClip, "adjust" | "filter">): Look {
  const filter = [adjustFilter(clip.adjust), presetFilter(clip.filter)]
    .filter((part) => part.length > 0)
    .join(" ");
  const preset = presetVeil(clip.filter);
  return {
    filter,
    veils: [...(preset ? [preset] : []), ...whiteBalanceVeils(clip.adjust)],
  };
}
