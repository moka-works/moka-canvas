import {
  DEFAULT_TEXT_CLIP_MS,
  MAX_CLIPS_PER_COMMAND,
  MAX_CLIPS_PER_TIMELINE,
  MAX_TIMELINE_TEXT_CONTENT,
  MIN_CLIP_DURATION_MS,
  createTextClip,
  defaultTextStyle,
  newId,
  nowIso,
  type ClipPatch,
  type DocumentCommand,
  type TextClipData,
  type TextClipStyle,
  type TimelineClip,
  type TimelineDocument,
  type TimelineTrack,
  type TrackId,
} from "../../../shared/domain";
import { execute } from "../../editor/commands/execute";
import { useAppStore } from "../../editor/stores/appStore";
import { i18n } from "../../../shared/i18n";
import { useClipStore } from "../stores/clipStore";
import { firstOverlap, parseSrt, type SrtCue } from "../subtitles/srt";
import { sameStyle } from "../textStyles";
import { formatTimecode, frameAligned } from "../timeline/timecode";
import {
  activeTimeline,
  firstAcceptingTrack,
  nextTrackName,
} from "./clipActions";

/**
 * Words on the cut: one clip at the playhead, or a whole subtitle file at
 * once.
 *
 * Everything hard about both is decided before a command is built: where the
 * words land on the frame clock, which row takes them, how a batch of cues is
 * cut into the steps one history entry may carry, and what the room says when
 * the batch would collide with what is already there. The planning is pure —
 * it takes the timeline as an argument and answers with a command array — so
 * the rules can be read and tested without a store, and the thin executors
 * below only hand the plan to `execute` and speak its verdict.
 */

function toast(kind: "info" | "success" | "error", message: string): void {
  useAppStore.getState().pushToast(kind, message);
}

// ---------------------------------------------------------------------------
// What the form is allowed to produce
// ---------------------------------------------------------------------------

/** The size range the form keeps to; the domain states no bounds of its own. */
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 240;
/** How wide an outline the form offers; zero means no outline. */
export const STROKE_WIDTH_MAX = 16;
/** What an oversized file is told before it is read at all. */
export const MAX_SUBTITLE_FILE_BYTES = 2 * 1024 * 1024;

/** A font size the form would commit: a whole number inside the range. */
export function clampFontSize(value: number): number {
  const whole = Number.isFinite(value) ? Math.round(value) : FONT_SIZE_MIN;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, whole));
}

/** An outline width the form would commit: a whole number, never negative. */
export function clampStrokeWidth(value: number): number {
  const whole = Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(STROKE_WIDTH_MAX, Math.max(0, whole));
}

/** The words kept to what one clip may say; the counter stops at the same place. */
export function clampTextContent(text: string): string {
  return text.slice(0, MAX_TIMELINE_TEXT_CONTENT);
}

/** A cue's words as one line: the author's breaks folded, cut to 40 characters. */
export function cueSummary(content: string): string {
  const line = content.replace(/\s*\n\s*/g, " ").trim();
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

/** A style made legal where the UI owns the bounds: whole sizes, no negatives. */
export function legalStyle(style: TextClipStyle): TextClipStyle {
  return {
    ...style,
    fontSize: clampFontSize(style.fontSize),
    strokeWidth: clampStrokeWidth(style.strokeWidth),
  };
}

/** A text clip built to the factory's own rules, wearing the asked-for style. */
export function styledTextClip(
  content: string,
  trackId: string,
  startMs: number,
  durationMs: number,
  style: TextClipStyle,
): TimelineClip {
  const clip = createTextClip(content, trackId, startMs, durationMs);
  return { ...clip, text: { content, style: legalStyle(style) } };
}

/** A text clip whose text a caller can read without a null check. */
export type TextClip = TimelineClip & { text: TextClipData };

function isTextClip(clip: TimelineClip): clip is TextClip {
  return clip.kind === "text" && clip.text !== undefined;
}

/**
 * The patches a style change leaves on a set of clips.
 *
 * Each clip keeps its own words and takes the new style whole; a clip already
 * wearing the style is left out, so pressing what is already set spends no
 * history. The patches are `updateClips` shapes, ready for `patchCommands`.
 */
export function styleApplyPatches(
  clips: readonly TimelineClip[],
  style: TextClipStyle,
): { clipId: string; patch: ClipPatch }[] {
  const legal = legalStyle(style);
  return clips.filter(isTextClip).flatMap((clip) => {
    if (sameStyle(clip.text.style, legal)) return [];
    return [
      {
        clipId: clip.id,
        patch: { text: { content: clip.text.content, style: legal } },
      },
    ];
  });
}

/** Whether two whole texts ask for the same words and the same look. */
export function sameText(a: TextClipData, b: TextClipData): boolean {
  return a.content === b.content && sameStyle(a.style, b.style);
}

// ---------------------------------------------------------------------------
// One clip at the playhead
// ---------------------------------------------------------------------------

/**
 * Lands a text clip where the playhead stands, and chooses it.
 *
 * The moment is put on the frame clock and the row is the first text track in
 * display order that will hold an edit; a cut with no such row grows one in
 * the same step, named by the one rule every other row is named by. The
 * factory makes the clip and the form's style is laid over it, so the label
 * and the timing are the factory's own. Null is a step that never landed.
 */
export function addTextClipAtPlayhead(
  content: string,
  style: TextClipStyle,
): TimelineClip | null {
  const timeline = activeTimeline();
  if (!timeline) return null;
  const words = clampTextContent(content);
  if (words.length === 0) return null;
  const startMs = frameAligned(
    useClipStore.getState().playheadMs,
    timeline.settings.fps,
  );
  const commands: DocumentCommand[] = [];
  const held = firstAcceptingTrack(timeline, "text");
  const track: TimelineTrack = held ?? {
    id: newId(),
    kind: "text",
    name: nextTrackName(timeline, "text"),
    muted: false,
    hidden: false,
    locked: false,
    createdAt: nowIso(),
  };
  if (!held)
    commands.push({ type: "addTrack", timelineId: timeline.id, track });
  const clip = styledTextClip(
    words,
    track.id,
    startMs,
    DEFAULT_TEXT_CLIP_MS,
    style,
  );
  commands.push({ type: "addClips", timelineId: timeline.id, clips: [clip] });
  const done = execute(i18n.t("clip:history.addTextClip"), commands);
  if (!done) return null;
  useClipStore.getState().select({ clipIds: [clip.id], transitionId: null });
  return clip;
}

// ---------------------------------------------------------------------------
// A cue edited where it stands
// ---------------------------------------------------------------------------

/**
 * Opens the in-place editor over a cue already on the cut.
 *
 * The clip is chosen and the playhead taken to its head when it stands
 * anywhere else — the words are about to be written against this moment, and
 * a preview of another place would answer the keyboard with the wrong picture.
 * The view is nudged so the cue is on screen before the editor opens over it.
 * A locked row is refused the way every other edit on it is refused.
 */
export function editCue(clip: TimelineClip): void {
  if (!isTextClip(clip)) return;
  const timeline = activeTimeline();
  if (!timeline) return;
  const track = timeline.tracks.find((row) => row.id === clip.trackId);
  if (track?.locked) {
    toast("error", i18n.t("clip:actions.trackLocked"));
    return;
  }
  const store = useClipStore.getState();
  store.select({ clipIds: [clip.id], transitionId: null });
  if (
    store.playheadMs < clip.startMs ||
    store.playheadMs >= clip.startMs + clip.durationMs
  ) {
    store.setPlayhead(clip.startMs);
  }
  store.revealMs(clip.startMs);
  store.setCueEditor({
    kind: "clip",
    clipId: clip.id,
    seed: clip.text.content,
  });
}

// ---------------------------------------------------------------------------
// A cue written where there is none yet
// ---------------------------------------------------------------------------

/** Why a new cue cannot land where it was asked to, in the room's own terms. */
export type CueWindowRefusal = "locked" | "full" | "noRoom";

export type CueWindowPlan =
  | {
      ok: true;
      startMs: number;
      /** How long the cue may run: the default, cut to the gap it lands in. */
      durationMs: number;
      /** The look it lands with: its row's nearest words, or the default. */
      style: TextClipStyle;
    }
  | { ok: false; reason: CueWindowRefusal };

/**
 * The window a new cue would take at a moment on a text row, or why it cannot.
 *
 * The moment goes on the frame clock and lands inside the gap it was pointed
 * at: the default length, or the room up to the next cue — the start stepping
 * back from a neighbour too close to end a whole cue before. A gap where even
 * the shortest cue does not fit is a refusal with its own words, as are a
 * locked row and a cut already at its ceiling.
 */
export function cueWindowAt(
  timeline: TimelineDocument,
  trackId: TrackId,
  atMs: number,
): CueWindowPlan {
  const track = timeline.tracks.find((row) => row.id === trackId);
  if (!track || track.kind !== "text") return { ok: false, reason: "noRoom" };
  if (track.locked) return { ok: false, reason: "locked" };
  if (timeline.clips.length >= MAX_CLIPS_PER_TIMELINE)
    return { ok: false, reason: "full" };
  const fps = timeline.settings.fps;
  const wanted = Math.max(0, frameAligned(atMs, fps));
  const onTrack = timeline.clips.filter((clip) => clip.trackId === trackId);
  const gapStart = onTrack
    .map((clip) => clip.startMs + clip.durationMs)
    .filter((end) => end <= wanted)
    .reduce((highest, end) => Math.max(highest, end), 0);
  const ahead = onTrack
    .map((clip) => clip.startMs)
    .filter((start) => start >= wanted)
    .reduce<number | null>(
      (nearest, start) => (nearest === null ? start : Math.min(nearest, start)),
      null,
    );
  const gapEnd = ahead ?? Number.POSITIVE_INFINITY;
  const startMs = Math.min(
    Math.max(wanted, gapStart),
    Math.max(gapStart, gapEnd - MIN_CLIP_DURATION_MS),
  );
  const durationMs = Math.min(DEFAULT_TEXT_CLIP_MS, gapEnd - startMs);
  if (durationMs < MIN_CLIP_DURATION_MS) return { ok: false, reason: "noRoom" };
  return {
    ok: true,
    startMs,
    durationMs,
    style: cueStyleAt(timeline, trackId, startMs),
  };
}

/**
 * The look a new cue takes: its row's nearest words, or the plain default.
 *
 * A cue added beside written ones continues their look — the row is what the
 * reader is working on, and restyling every addition by hand would be the
 * room's failure, not their job. The words before the moment win, and a row
 * written only ahead of it gives the first of those.
 */
export function cueStyleAt(
  timeline: TimelineDocument,
  trackId: TrackId,
  atMs: number,
): TextClipStyle {
  const words = timeline.clips.filter(
    (clip) => clip.trackId === trackId && clip.kind === "text" && clip.text,
  );
  if (words.length === 0) return defaultTextStyle();
  const before = words
    .filter((clip) => clip.startMs <= atMs)
    .sort((a, b) => b.startMs - a.startMs)[0];
  const chosen = before ?? [...words].sort((a, b) => a.startMs - b.startMs)[0];
  return { ...chosen.text!.style };
}

/** What the room says when a new cue is refused. */
function cueRefusal(reason: CueWindowRefusal): string {
  if (reason === "locked") return i18n.t("clip:actions.trackLocked");
  if (reason === "full")
    return i18n.t("clip:subtitles.clipLimit", {
      max: MAX_CLIPS_PER_TIMELINE,
      extra: 1,
    });
  return i18n.t("clip:cues.noRoom");
}

/**
 * Opens the in-place editor where a new cue would land on a text row.
 *
 * The window is the plan's; the playhead is taken to it when it stands
 * anywhere else, exactly as editing an existing cue does, and the frame is
 * brought into view before the editor opens over it.
 */
export function newCueAt(trackId: TrackId, atMs: number): void {
  const timeline = activeTimeline();
  if (!timeline) return;
  const plan = cueWindowAt(timeline, trackId, atMs);
  if (!plan.ok) {
    toast("error", cueRefusal(plan.reason));
    return;
  }
  const store = useClipStore.getState();
  store.revealMs(plan.startMs);
  if (
    store.playheadMs < plan.startMs ||
    store.playheadMs >= plan.startMs + plan.durationMs
  ) {
    store.setPlayhead(plan.startMs);
  }
  store.setCueEditor({
    kind: "new",
    trackId,
    startMs: plan.startMs,
    durationMs: plan.durationMs,
    style: plan.style,
  });
}

/**
 * Lands a whole new cue: one command, one step of history, chosen after.
 *
 * Empty words are a cue nobody wrote: nothing lands and null is the answer,
 * which is also what a refused command answers with.
 */
export function addTextClipAt(
  trackId: TrackId,
  startMs: number,
  durationMs: number,
  style: TextClipStyle,
  content: string,
): TimelineClip | null {
  const timeline = activeTimeline();
  if (!timeline) return null;
  const words = clampTextContent(content);
  if (words.length === 0) return null;
  const clip = styledTextClip(words, trackId, startMs, durationMs, style);
  const done = execute(i18n.t("clip:history.addTextClip"), [
    { type: "addClips", timelineId: timeline.id, clips: [clip] },
  ]);
  if (!done) return null;
  useClipStore.getState().select({ clipIds: [clip.id], transitionId: null });
  return clip;
}

// ---------------------------------------------------------------------------
// A subtitle file
// ---------------------------------------------------------------------------

/**
 * Which row a batch of cues is laid on.
 *
 * `firstTextTrack` is what bringing a file in does: the subtitles of a cut go
 * to its first text row, and a cut with none grows one. `newTrack` is what a
 * transcript does — it is a second reading of the same sound rather than a
 * replacement of the first, so it is given a row of its own and never touches
 * what is already written.
 */
export type SrtPlacement = "firstTextTrack" | "newTrack";

export type SrtImportPlan =
  | {
      ok: true;
      commands: DocumentCommand[];
      /** The clips the commands land, in cue order. */
      clips: TimelineClip[];
      /** Cues dropped because they were too short to be seen. */
      skipped: number;
    }
  | { ok: false; message: string };

/**
 * The commands a subtitle file would land, or the words the room refuses it in.
 *
 * Both ends of a cue are put on the frame clock and a cue that rounds to less
 * than a clip can be is dropped and counted — never stretched, since stretching
 * would run it into its neighbour. What is left is checked before any command
 * is built: cues against each other and against what the target row already
 * holds, naming the first pair; then the timeline's clip ceiling, saying how
 * many would have to be deleted. The target row is the first text track in
 * document order, exactly as §3 states, and a cut with none grows one as the
 * plan's first command. The batch is cut into `addClips` steps no larger than
 * one command may hold, all of them in the single entry `execute` records.
 *
 * A row of its own carries no clash to check: nothing is on it yet, and the
 * cues are already known to keep out of each other's way.
 */
export function srtImportPlan(
  timeline: TimelineDocument,
  cues: readonly SrtCue[],
  style: TextClipStyle,
  placement: SrtPlacement = "firstTextTrack",
): SrtImportPlan {
  const fps = timeline.settings.fps;
  const aligned: SrtCue[] = [];
  let skipped = 0;
  for (const cue of cues) {
    const startMs = frameAligned(cue.startMs, fps);
    const endMs = frameAligned(cue.endMs, fps);
    if (endMs - startMs < MIN_CLIP_DURATION_MS) {
      skipped += 1;
      continue;
    }
    aligned.push({ startMs, endMs, text: clampTextContent(cue.text) });
  }
  if (aligned.length === 0) {
    return {
      ok: false,
      message: i18n.t("clip:subtitles.noCuesLongEnough"),
    };
  }
  const clash = firstOverlap(aligned);
  if (clash) {
    return {
      ok: false,
      message: i18n.t("clip:subtitles.overlapEachOther", {
        timecode: formatTimecode(
          Math.max(clash[0].startMs, clash[1].startMs),
          fps,
        ),
      }),
    };
  }
  const target =
    placement === "newTrack"
      ? null
      : (timeline.tracks.find((track) => track.kind === "text") ?? null);
  if (target) {
    for (const cue of aligned) {
      const collision = timeline.clips.some(
        (clip) =>
          clip.trackId === target.id &&
          cue.startMs < clip.startMs + clip.durationMs &&
          clip.startMs < cue.endMs,
      );
      if (collision) {
        return {
          ok: false,
          message: i18n.t("clip:subtitles.overlapClip", { name: target.name }),
        };
      }
    }
  }
  const total = timeline.clips.length + aligned.length;
  if (total > MAX_CLIPS_PER_TIMELINE) {
    return {
      ok: false,
      message: i18n.t("clip:subtitles.clipLimit", {
        max: MAX_CLIPS_PER_TIMELINE,
        extra: total - MAX_CLIPS_PER_TIMELINE,
      }),
    };
  }

  const commands: DocumentCommand[] = [];
  const track: TimelineTrack = target ?? {
    id: newId(),
    kind: "text",
    name: nextTrackName(timeline, "text"),
    muted: false,
    hidden: false,
    locked: false,
    createdAt: nowIso(),
  };
  if (!target)
    commands.push({ type: "addTrack", timelineId: timeline.id, track });
  const clips = aligned.map((cue) =>
    styledTextClip(
      cue.text,
      track.id,
      cue.startMs,
      cue.endMs - cue.startMs,
      style,
    ),
  );
  for (let at = 0; at < clips.length; at += MAX_CLIPS_PER_COMMAND) {
    commands.push({
      type: "addClips",
      timelineId: timeline.id,
      clips: clips.slice(at, at + MAX_CLIPS_PER_COMMAND),
    });
  }
  return { ok: true, commands, clips, skipped };
}

/**
 * A subtitle file brought in: read, planned, landed in one step, and answered.
 *
 * The reading and the plan do the deciding; what is left here is the verdict
 * the reader hears — a file with nothing to say, a batch the room refuses, or
 * the count of cues that arrived and cues that were too short to keep.
 */
export function importSrt(text: string, style: TextClipStyle): void {
  const timeline = activeTimeline();
  if (!timeline) return;
  const parsed = parseSrt(text);
  if (!parsed.ok) {
    toast("error", parsed.message);
    return;
  }
  const plan = srtImportPlan(timeline, parsed.cues, style);
  if (!plan.ok) {
    toast("error", plan.message);
    return;
  }
  const done = execute(i18n.t("clip:history.importSubtitles"), plan.commands);
  if (!done) return;
  const skipped = parsed.skipped + plan.skipped;
  const cues = plan.clips.length;
  toast(
    "success",
    skipped > 0
      ? i18n.t("clip:subtitles.importedWithSkipped", { cues, skipped })
      : i18n.t("clip:subtitles.imported", { cues }),
  );
}

/**
 * A transcript laid down: a row of its own, in one step of history.
 *
 * A transcript never stands in for what is already written, so the plan is
 * asked for a new row and the room's own clash check has nothing to say. The
 * verdict comes back rather than being spoken here: the caller knows how many
 * cues were dropped before the plan ever saw them and says both counts in one
 * breath. Null is a step that never landed at all.
 */
export function landTranscribedCues(
  cues: readonly SrtCue[],
  style: TextClipStyle,
): { ok: true; clips: TimelineClip[] } | { ok: false; message: string } | null {
  const timeline = activeTimeline();
  if (!timeline) return null;
  const plan = srtImportPlan(timeline, cues, style, "newTrack");
  if (!plan.ok) return { ok: false, message: plan.message };
  const done = execute(i18n.t("clip:history.transcribe"), plan.commands);
  if (!done) return null;
  return { ok: true, clips: plan.clips };
}
