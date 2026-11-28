import {
  CLIP_LABEL_MAX,
  MAX_CLIP_SPEED,
  MAX_CLIPS_PER_COMMAND,
  MIN_CLIP_DURATION_MS,
  MIN_CLIP_SPEED,
  type ClipAdjust,
  type ClipPatch,
  type DocumentCommand,
  type TimelineClip,
  type TimelineId,
} from "../../../shared/domain";
import { trimDraft, type TrimMaterial } from "../interactions/gestures";
import { frameAligned } from "../timeline/timecode";

/**
 * What the clip fields mean, without a panel around them.
 *
 * The inspector is a form over the document, and every hard part of that form
 * is arithmetic rather than markup: how a speed change lands, how long a clip
 * may be pulled, what a set of clips agrees on, and where a grade sits on a
 * hundred-unit slider. Kept here so the panel stays a drawing of these
 * answers and the tests can ask them directly.
 */

/** A grade the reader has not touched: below this a nudge is not worth carrying. */
export const ADJUST_FLOOR = 0.005;

/** Clamped to the fraction range a grade is stated in, non-numbers read as untouched. */
export function clampAdjust(adjust: ClipAdjust): ClipAdjust {
  const axis = (value: number) =>
    Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  const clamped: ClipAdjust = {
    brightness: axis(adjust.brightness),
    contrast: axis(adjust.contrast),
    saturation: axis(adjust.saturation),
  };
  if (adjust.temperature !== undefined) {
    const temperature = axis(adjust.temperature);
    if (Math.abs(temperature) > ADJUST_FLOOR) clamped.temperature = temperature;
  }
  if (adjust.tint !== undefined) {
    const tint = axis(adjust.tint);
    if (Math.abs(tint) > ADJUST_FLOOR) clamped.tint = tint;
  }
  return clamped;
}

/** Whether a grade asks for nothing at all, which is stored as no grade. */
export function adjustIsUntouched(adjust: ClipAdjust): boolean {
  return (
    Math.abs(adjust.brightness) <= ADJUST_FLOOR &&
    Math.abs(adjust.contrast) <= ADJUST_FLOOR &&
    Math.abs(adjust.saturation) <= ADJUST_FLOOR &&
    Math.abs(adjust.temperature ?? 0) <= ADJUST_FLOOR &&
    Math.abs(adjust.tint ?? 0) <= ADJUST_FLOOR
  );
}

/** The grade a slider at -100..100 stands for. */
export function adjustFromSlider(slider: number): number {
  const whole = Number.isFinite(slider) ? Math.round(slider) : 0;
  return Math.max(-100, Math.min(100, whole)) / 100;
}

/** Where a -1..1 grade sits on its slider. */
export function sliderFromAdjust(value: number): number {
  const clamped = clampAdjust({
    brightness: value,
    contrast: 0,
    saturation: 0,
  });
  return Math.round(clamped.brightness * 100);
}

/** The value every clip agrees on, or null when they disagree or there are none. */
export function sharedValue<T>(values: readonly T[]): T | null {
  if (values.length === 0) return null;
  const first = values[0];
  return values.every((value) => value === first) ? first : null;
}

/** A whole number inside a range, or null when the text is not one. */
export function wholeNumberIn(
  text: string,
  min: number,
  max: number,
): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

/**
 * The clip a speed change would leave: the same window read at a new pace.
 *
 * The identity `round(duration × speed) === out − in` is the document's, so
 * the duration is the window over the new speed and the out point follows it
 * by the millisecond the rounding costs — the same shape a split's two sides
 * are built in, and never more than a millisecond of drift.
 *
 * A clip whose material clock is its own duration — a picture, a cue — keeps
 * that window exactly, which pins its speed at 1: there is no longer run of
 * material to read, so there is nothing to read faster.
 */
export function speedPatch(
  clip: TimelineClip,
  speed: number,
  ownClock = false,
): ClipPatch | null {
  if (!Number.isFinite(speed)) return null;
  if (speed < MIN_CLIP_SPEED || speed > MAX_CLIP_SPEED) return null;
  // A picture or a cue has no run of material of its own to read faster: its
  // window is its duration, which pins its pace at 1.
  if (ownClock) return null;
  const span = clip.outPointMs - clip.inPointMs;
  const durationMs = Math.round(span / speed);
  if (durationMs < MIN_CLIP_DURATION_MS) return null;
  const patch: ClipPatch = { speed, durationMs };
  const outPointMs = clip.inPointMs + Math.round(durationMs * speed);
  if (outPointMs !== clip.outPointMs) patch.outPointMs = outPointMs;
  return patch;
}

/** Whether a clip's pace may be changed at all: a still has none of its own. */
export function speedIsLocked(material: TrimMaterial): boolean {
  return material.ownClock;
}

/**
 * The clip a duration typed into the field would leave.
 *
 * The right edge is the gesture's own arithmetic: the wanted duration is
 * clamped between a whole frame and whatever the material allows, so a
 * duration field can never ask for something a trim could not be dragged to.
 * The out point is then read from the duration, which is how the identity
 * survives a picture's window being its own length.
 */
export function durationPatch(
  clip: TimelineClip,
  wantedMs: number,
  fps: number,
  material: TrimMaterial,
): ClipPatch {
  if (!Number.isFinite(wantedMs)) return {};
  const drafted = trimDraft({
    clip,
    edge: "end",
    deltaMs: Math.round(wantedMs) - clip.durationMs,
    fps,
    material,
    ctx: { playheadMs: 0, edges: [] },
    pxPerSec: 1,
    snapEnabled: false,
  });
  const patch: ClipPatch = {};
  if (drafted.durationMs !== clip.durationMs)
    patch.durationMs = drafted.durationMs;
  const outPointMs =
    clip.inPointMs + Math.round(drafted.durationMs * clip.speed);
  if (outPointMs !== clip.outPointMs) patch.outPointMs = outPointMs;
  return patch;
}

/**
 * The clip a move typed into the Start field would leave.
 *
 * The head of the cut is the floor and the frame clock is the grid; a move
 * that would land on a neighbour is left to the command layer, which is the
 * only place that reads the whole track.
 */
export function startPatch(
  clip: TimelineClip,
  wantedMs: number,
  fps: number,
): ClipPatch {
  if (!Number.isFinite(wantedMs)) return {};
  const startMs = Math.max(0, frameAligned(Math.round(wantedMs), fps));
  return startMs === clip.startMs ? {} : { startMs };
}

/**
 * A fade length the pair can honestly hold.
 *
 * Each fade is whole milliseconds no longer than the clip and no longer than
 * what is left of it once the other fade is taken; the domain states the same
 * ceiling, and clamping here keeps it from ever being the thing that refuses
 * a reader's number.
 */
export function clampFade(
  valueMs: number,
  durationMs: number,
  otherFadeMs: number,
): number {
  const wanted = Number.isFinite(valueMs) ? Math.round(valueMs) : 0;
  return Math.max(0, Math.min(wanted, Math.max(0, durationMs - otherFadeMs)));
}

/** A label worth carrying, or null when it is not a name. */
export function labelText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > CLIP_LABEL_MAX) return null;
  return trimmed;
}

/**
 * Many clip patches as the commands one history entry can carry.
 *
 * One command holds at most fifty patches, and a wider selection is sent as
 * several commands inside a single `execute` — one label, one undo, however
 * many pieces were written to.
 */
export function patchCommands(
  timelineId: TimelineId,
  patches: { clipId: string; patch: ClipPatch }[],
): DocumentCommand[] {
  const commands: DocumentCommand[] = [];
  for (let at = 0; at < patches.length; at += MAX_CLIPS_PER_COMMAND) {
    commands.push({
      type: "updateClips",
      timelineId,
      patches: patches.slice(at, at + MAX_CLIPS_PER_COMMAND),
    });
  }
  return commands;
}
