/**
 * Laying a telling's shots end to end as one timeline.
 *
 * Everything here is arithmetic over the document: which clips the fourth step
 * has made, in what order they go, where each of them lands, and what one
 * `execute` has to write to put them there. Nothing reads a store or asks a
 * server, so what an assembly will do is the same answer in a test, in the
 * warning a reader is shown, and in the commands that are finally written.
 *
 * A telling is assembled twice over in the ordinary run of things — once when
 * its clips are first cut, and again every time another act is filmed — so what
 * goes on the timeline is planned first and looked at before it is applied, and
 * an assembly with nothing to lay down is refused rather than written empty.
 */

import { CommandError } from "../../shared/domain/commands";
import { MAX_CLIPS_PER_TIMELINE } from "../../shared/domain/constants";
import { fnv1a } from "../../shared/domain/digest";
import {
  createClipFromAsset,
  createTextClip,
  createTimeline,
  emptyStorySlot,
} from "../../shared/domain/factories";
import { newId, nowIso } from "../../shared/domain/ids";
import { findResource } from "../../shared/domain/validate";
import {
  actPlannedMs,
  currentTake,
  takeFile,
  timelineSizeForAspect,
  voiceTakeOf,
} from "../../shared/domain/story";
import type {
  AssetId,
  DocumentCommand,
  MokaFile,
  ResourceEntry,
  StoryAct,
  StoryDocument,
  StoryEdit,
  StoryKeyframe,
  StoryTake,
  TimelineClip,
  TimelineDocument,
  TimelineTrack,
} from "../../shared/domain/types";
import { i18n } from "../../shared/i18n";
import { planDubbing, spokenLines, type DubCue } from "./dubbing";

/** How a finished cut is framed, whichever telling it came from. */
const ASSEMBLY_FPS = 30;
const ASSEMBLY_BACKGROUND = "#000000";

/** One shot of the finished film, before it becomes a clip. */
export interface AssemblyUnit {
  actId: string;
  keyframeId?: string;
  /** Which episode this is, counted from one. */
  chapterIndex: number;
  /** Which act of that episode, counted from one. */
  actIndex: number;
  /** Where it lands on the timeline, in milliseconds. */
  startMs: number;
  /** How long it runs: what the material measures, or what it was planned for. */
  durationMs: number;
  /** The file of the fourth step that is laid down. */
  assetId: AssetId;
  /** What the shot was planned to run for, which is what its captions share. */
  plannedMs: number;
}

/** Something about the telling that the reader should know before assembling. */
export interface AssemblyWarning {
  kind: "noVideo" | "assetMissing" | "noDuration";
  chapterId: string;
  actId: string;
  keyframeId?: string;
  /** Where the shot is, in the reader's language: "Episode 2 · Act 3". */
  place: string;
}

/** What an assembly would lay down, and what is worth saying about it. */
export interface AssemblyPlan {
  units: AssemblyUnit[];
  warnings: AssemblyWarning[];
  /** How long the finished cut runs, in the lengths the plan knows. */
  totalPlannedMs: number;
}

/** What one shot of the plan is made of, at the granularity in force. */
interface ShotSlot {
  keyframe?: StoryKeyframe;
  /**
   * The files the shot's clip is, in the order they play: one for a shot, and
   * several for an act that outran one clip and was filmed in pieces.
   */
  assetIds: AssetId[];
  plannedMs: number;
}

/**
 * The shots of an act as they are laid down, at the granularity in force.
 *
 * One shot per act when clips are made by act, and one per keyframe when they
 * are made by keyframe — the difference between a film of six long takes and
 * one of thirty short ones, decided here and nowhere else. An act filmed in
 * pieces is one shot of several files, laid down one after another: the pieces
 * on the track in the order they were filmed in, which is the act.
 */
function shotsOf(story: StoryDocument, act: StoryAct): ShotSlot[] {
  if (story.shotGranularity === "keyframe") {
    return act.keyframes.map((keyframe) => {
      const file = takeFile(currentTake(keyframe.video));
      return {
        keyframe,
        assetIds: file === undefined ? [] : [file],
        plannedMs: keyframe.durationMs,
      };
    });
  }
  const take = currentTake(act.video);
  return [
    {
      assetIds: take?.assetIds ?? [],
      plannedMs: actPlannedMs(act),
    },
  ];
}

/** How long a clip runs: what the material measures, or what it was planned for. */
function lengthOf(resource: ResourceEntry, plannedMs: number): number {
  return resource.probe?.durationMs ?? plannedMs;
}

/**
 * The score of each act, and the older whole-act readings still in use.
 *
 * A telling's lines are read one by one and cued to their own shots (see
 * {@link planDubbing}); what is left for the act itself is the score, and the
 * reading of the whole act made before its lines had voices of their own — a
 * take an act still holds but no line does. The two never both sound: once any
 * line of the act has been read, the lines are what the act says. An act whose
 * first shot never made it has nowhere to put its sound — a voice over nothing
 * would be a piece of the telling the film has not got to yet — so it is left
 * out.
 */
function soundCues(
  story: StoryDocument,
  plan: AssemblyPlan,
): Array<{
  actId: string;
  kind: "voice" | "music";
  take: StoryTake;
  startMs: number;
}> {
  const starts = new Map<string, number>();
  for (const unit of plan.units) {
    if (!starts.has(unit.actId)) starts.set(unit.actId, unit.startMs);
  }
  const cues: Array<{
    actId: string;
    kind: "voice" | "music";
    take: StoryTake;
    startMs: number;
  }> = [];
  for (const chapter of story.chapters) {
    for (const act of chapter.acts) {
      const startMs = starts.get(act.id);
      if (startMs === undefined) continue;
      for (const kind of ["voice", "music"] as const) {
        if (kind === "voice" && readPerLine(act)) continue;
        const take = currentTake(
          (kind === "voice" ? act.voice : act.music) ?? emptyStorySlot(),
        );
        if (take !== undefined)
          cues.push({ actId: act.id, kind, take, startMs });
      }
    }
  }
  return cues;
}

/** Whether an act's lines are read one by one, which is how a telling sounds now. */
function readPerLine(act: StoryAct): boolean {
  return act.keyframes.some((keyframe) =>
    spokenLines(keyframe).some(
      (line) => voiceTakeOf(keyframe, line.id) !== undefined,
    ),
  );
}

/**
 * Which row of the timeline each kind of sound goes on.
 *
 * A telling with both a voice-over and a score gets two rows, so a reader can
 * weigh them apart afterwards: the first audio row carries the voice, the
 * second carries the music, and a row that is not there yet is made rather
 * than the sound being dropped for want of somewhere to put it.
 */
function soundRows(
  story: StoryDocument,
  tracks: TimelineDocument["tracks"],
): {
  rows: { voice?: string; music?: string };
  added: TimelineTrack[];
} {
  const voiced = story.chapters.some((chapter) =>
    chapter.acts.some((act) => act.voice !== undefined || readPerLine(act)),
  );
  const scored = story.chapters.some((chapter) =>
    chapter.acts.some((act) => act.music !== undefined),
  );
  const audio = tracks.filter((track) => track.kind === "audio");
  const added: TimelineTrack[] = [];
  const row = (name: string): TimelineTrack => {
    const track: TimelineTrack = {
      id: newId(),
      kind: "audio",
      name,
      muted: false,
      hidden: false,
      locked: false,
      createdAt: nowIso(),
    };
    added.push(track);
    return track;
  };
  const rows: { voice?: string; music?: string } = {};
  if (voiced)
    rows.voice = (audio.shift() ?? row(i18n.t("story:edit.voiceTrack"))).id;
  if (scored)
    rows.music = (audio.shift() ?? row(i18n.t("story:edit.musicTrack"))).id;
  return { rows, added };
}

/**
 * Every clip the fourth step has made, in the order it is played in.
 *
 * The order is the telling's own: episode, then act, then shot. A shot with no
 * clip is named in the warnings rather than passed over in silence — a reader
 * being shown a film with a hole in it wants to know where the hole is.
 */
export function planAssembly(
  story: StoryDocument,
  moka: MokaFile,
): AssemblyPlan {
  const units: AssemblyUnit[] = [];
  const warnings: AssemblyWarning[] = [];
  let at = 0;

  story.chapters.forEach((chapter, chapterAt) => {
    chapter.acts.forEach((act, actAt) => {
      const place = i18n.t("story:edit.place", {
        chapter: chapterAt + 1,
        act: actAt + 1,
      });
      for (const shot of shotsOf(story, act)) {
        const where = {
          chapterId: chapter.id,
          actId: act.id,
          ...(shot.keyframe === undefined
            ? {}
            : { keyframeId: shot.keyframe.id }),
          place,
        };
        if (shot.assetIds.length === 0) {
          warnings.push({ kind: "noVideo", ...where });
          continue;
        }
        // A piece with no measured length stands in at its even share of the
        // act's plan, which is only ever read when the probe said nothing.
        const share = Math.round(shot.plannedMs / shot.assetIds.length);
        for (const assetId of shot.assetIds) {
          const resource = findResource(moka, assetId);
          if (resource === undefined) {
            // An asset the document no longer holds cannot be laid on a track:
            // the clip would be a hole with a name. Saying which one is the
            // useful part of finding out.
            warnings.push({ kind: "assetMissing", ...where });
            continue;
          }
          if (resource.probe?.durationMs === undefined) {
            warnings.push({ kind: "noDuration", ...where });
          }
          const durationMs = lengthOf(resource, share);
          units.push({
            actId: act.id,
            ...(shot.keyframe === undefined
              ? {}
              : { keyframeId: shot.keyframe.id }),
            chapterIndex: chapterAt + 1,
            actIndex: actAt + 1,
            startMs: at,
            durationMs,
            assetId,
            plannedMs: share,
          });
          at += durationMs;
        }
      }
    });
  });

  return {
    units,
    warnings,
    totalPlannedMs: units.reduce((sum, unit) => sum + unit.durationMs, 0),
  };
}

/**
 * What assembling writes, as the one batch of commands it is.
 *
 * A telling assembled for the first time brings a timeline of its own with it;
 * one assembled again edits that same timeline — taking back only the clips it
 * laid down itself, so a reader's own work on the same track is left where it
 * stands. Either way it is one step of the history, because it is one thing the
 * reader asked for.
 */
export function assemblyCommands(
  story: StoryDocument,
  moka: MokaFile,
  plan: AssemblyPlan,
  options: { withSubtitles: boolean; timelineId?: string },
): {
  commands: DocumentCommand[];
  clipByAct: NonNullable<StoryEdit["clipByAct"]>;
} {
  if (plan.units.length === 0) {
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("story:edit.nothingToAssemble"),
    );
  }
  const size = timelineSizeForAspect(story.brief.aspect);
  const target =
    options.timelineId === undefined
      ? undefined
      : (moka.timelines ?? []).find((held) => held.id === options.timelineId);

  if (target === undefined) {
    const timeline = createTimeline(
      i18n.t("story:edit.timelineName", { name: story.name }),
      {
        width: size.width,
        height: size.height,
        fps: ASSEMBLY_FPS,
        background: ASSEMBLY_BACKGROUND,
      },
    );
    // A timeline this telling is making can have its rows named for what they
    // carry; one a reader has worked on keeps whatever names it was given.
    const sound = soundRows(story, timeline.tracks);
    const tracks = [...timeline.tracks, ...sound.added].map((track) =>
      track.id === sound.rows.voice
        ? { ...track, name: i18n.t("story:edit.voiceTrack") }
        : track,
    );
    const { clips, clipByAct } = layDown(story, moka, plan, {
      tracks,
      rows: sound.rows,
      withSubtitles: options.withSubtitles,
    });
    return {
      commands: [
        { type: "addTimeline", timeline: { ...timeline, tracks, clips } },
      ],
      clipByAct,
    };
  }

  // A timeline that has lost its video row cannot carry a film: a fresh one is
  // made rather than a telling quietly laid down on the sound track.
  if (target.tracks.every((track) => track.kind !== "video")) {
    const timeline = createTimeline(
      i18n.t("story:edit.timelineName", { name: story.name }),
      {
        width: size.width,
        height: size.height,
        fps: ASSEMBLY_FPS,
        background: ASSEMBLY_BACKGROUND,
      },
    );
    return {
      commands: [{ type: "addTimeline", timeline: { ...timeline, clips: [] } }],
      clipByAct: [],
    };
  }

  const sound = soundRows(story, target.tracks);
  const { clips, clipByAct } = layDown(story, moka, plan, {
    tracks: [...target.tracks, ...sound.added],
    rows: sound.rows,
    withSubtitles: options.withSubtitles,
  });

  const commands: DocumentCommand[] = [];
  // Only what this telling put there: a clip the reader added by hand, or
  // another telling laid down, is not this one's to take away.
  const mine = (story.edit.clipByAct ?? [])
    .map((entry) => entry.clipId)
    .filter((clipId) => target.clips.some((clip) => clip.id === clipId));
  if (mine.length > 0) {
    commands.push({
      type: "removeClips",
      timelineId: target.id,
      clipIds: mine,
    });
  }
  for (const track of sound.added) {
    commands.push({ type: "addTrack", timelineId: target.id, track });
  }
  commands.push({ type: "addClips", timelineId: target.id, clips });
  const { width, height } = target.settings;
  if (width !== size.width || height !== size.height) {
    commands.push({
      type: "updateTimelineSettings",
      timelineId: target.id,
      settings: { width: size.width, height: size.height },
    });
  }
  return { commands, clipByAct };
}

/**
 * A telling's clips on a timeline of the reader's own naming.
 *
 * The fifth step's assembly writes into the timeline the telling owns and
 * rearranges it every time another act is filmed. This is the other way out: a
 * cut that stands beside it and that the telling never touches again, so a
 * reader can move its clips about freely without the next assembly walking over
 * their work. What is laid down is the same arithmetic — every clip the fourth
 * step made, in telling order, with each act's voice and score cued under it —
 * and no captions: a reader who wants the lines written on the cut can add them
 * in the cutting room, where they are theirs to place.
 */
export function importTimelineCommands(
  story: StoryDocument,
  moka: MokaFile,
  name: string,
): { commands: DocumentCommand[]; timelineId: string; clips: number } {
  const plan = planAssembly(story, moka);
  if (plan.units.length === 0) {
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("story:edit.nothingToAssemble"),
    );
  }
  const size = timelineSizeForAspect(story.brief.aspect);
  const timeline = createTimeline(name, {
    width: size.width,
    height: size.height,
    fps: ASSEMBLY_FPS,
    background: ASSEMBLY_BACKGROUND,
  });
  const sound = soundRows(story, timeline.tracks);
  const tracks = [...timeline.tracks, ...sound.added].map((track) =>
    track.id === sound.rows.voice
      ? { ...track, name: i18n.t("story:edit.voiceTrack") }
      : track,
  );
  const { clips } = layDown(story, moka, plan, {
    tracks,
    rows: sound.rows,
    withSubtitles: false,
  });
  // A standing timeline is added whole, which is the one way clips land without
  // the command that counts them — so the ceiling a cut holds is asked here
  // rather than discovered by a document that would carry more than it may.
  if (clips.length > MAX_CLIPS_PER_TIMELINE) {
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("story:import.tooManyClips", { max: MAX_CLIPS_PER_TIMELINE }),
    );
  }
  return {
    commands: [
      { type: "addTimeline", timeline: { ...timeline, tracks, clips } },
    ],
    timelineId: timeline.id,
    clips: clips.length,
  };
}

/** The clips a plan makes, and where each of them came from. */
function layDown(
  story: StoryDocument,
  moka: MokaFile,
  plan: AssemblyPlan,
  options: {
    tracks: TimelineDocument["tracks"];
    rows: { voice?: string; music?: string };
    withSubtitles: boolean;
  },
): {
  clips: TimelineClip[];
  clipByAct: NonNullable<StoryEdit["clipByAct"]>;
} {
  const clips: TimelineClip[] = [];
  const clipByAct: NonNullable<StoryEdit["clipByAct"]> = [];
  const videoTrack = options.tracks.find((track) => track.kind === "video");
  if (videoTrack === undefined) return { clips, clipByAct };
  const textTrack = options.tracks.find((track) => track.kind === "text");

  for (const unit of plan.units) {
    const resource = findResource(moka, unit.assetId);
    if (resource === undefined) continue;
    const clip = createClipFromAsset(resource, videoTrack.id, unit.startMs);
    clips.push({
      ...clip,
      durationMs: unit.durationMs,
      inPointMs: 0,
      outPointMs: unit.durationMs,
    });
    clipByAct.push({
      actId: unit.actId,
      ...(unit.keyframeId === undefined ? {} : { keyframeId: unit.keyframeId }),
      clipId: clip.id,
    });
  }

  // The lines, each cued inside the shot it is said in: a telling is read one
  // line at a time, so what lies over a shot is what that shot says. A line
  // that runs past its window is laid as far as it goes rather than cut: the
  // reader is told, and the words are theirs to shorten.
  const dubbing = planDubbing(
    story,
    plan.units,
    (assetId) => findResource(moka, assetId)?.probe?.durationMs,
  );
  if (options.rows.voice !== undefined) {
    for (const cue of dubbing.cues) {
      const resource = findResource(moka, cue.assetId);
      if (resource === undefined) continue;
      const clip = createClipFromAsset(
        resource,
        options.rows.voice,
        cue.startMs,
      );
      clips.push({
        ...clip,
        kind: "audio",
        durationMs: cue.durationMs,
        inPointMs: 0,
        // What is played: the file's own length, or — unmeasured — as much of
        // it as the window holds.
        outPointMs: cue.materialMs ?? cue.durationMs,
        speed: cue.speed,
      });
      clipByAct.push({
        actId: cue.actId,
        keyframeId: cue.keyframeId,
        clipId: clip.id,
      });
    }
  }

  // The score, and the older whole-act readings of tellings that have not been
  // read line by line: cued to the act, since the whole of it is what they are.
  for (const cue of soundCues(story, plan)) {
    const trackId =
      cue.kind === "voice" ? options.rows.voice : options.rows.music;
    if (trackId === undefined) continue;
    const resource = findResource(moka, cue.take.assetIds[0]);
    if (resource === undefined) continue;
    const clip = createClipFromAsset(resource, trackId, cue.startMs);
    clips.push({ ...clip, kind: "audio" });
    clipByAct.push({
      actId: cue.actId,
      // An empty id says this clip is a piece of the whole act rather than one
      // shot of it, which is what a re-assembly has to take back too.
      keyframeId: "",
      clipId: clip.id,
    });
  }

  if (options.withSubtitles && textTrack !== undefined) {
    for (const line of captions(story, plan, dubbing.cues, textTrack.id)) {
      clips.push(line.clip);
      clipByAct.push({
        actId: line.actId,
        // An empty id says this clip is what the whole act says rather than
        // one shot of it, which is what a re-assembly has to take back too.
        keyframeId: "",
        clipId: line.clip.id,
      });
    }
  }
  return { clips, clipByAct };
}

/**
 * Every line of the telling, as a caption inside the shot it is said in.
 *
 * A caption sits where its shot does, and several lines of one shot share the
 * length that shot was planned to run for. A line that has been read aloud sits
 * where its reading does and lasts as long as it does — the words on screen and
 * the words in the ear are the same words — and one too long for its share of
 * the shot keeps it to the end of what was said rather than vanishing under the
 * voice. The plan is deliberate: a clip that came back longer than it was asked
 * for must not drag the last line of a shot into the mouth of the next one.
 */
function captions(
  story: StoryDocument,
  plan: AssemblyPlan,
  cues: DubCue[],
  trackId: string,
): Array<{ actId: string; clip: TimelineClip }> {
  const lines: Array<{ actId: string; clip: TimelineClip }> = [];
  const cued = new Map(cues.map((cue) => [cue.lineId, cue]));
  for (const chapter of story.chapters) {
    for (const act of chapter.acts) {
      const starts = shotWindows(story, act, plan.units);
      for (const keyframe of act.keyframes) {
        const window = starts.get(keyframe.id);
        const told = keyframe.dialogue;
        if (window === undefined || told.length === 0) continue;
        const share = Math.round(keyframe.durationMs / told.length);
        told.forEach((line, at) => {
          const words =
            line.speaker.trim() === ""
              ? line.text
              : i18n.t("story:edit.line", {
                  speaker: line.speaker,
                  text: line.text,
                });
          const held = cued.get(line.id);
          const startMs = held?.startMs ?? window.startMs + share * at;
          const endMs =
            held === undefined
              ? window.startMs + share * (at + 1)
              : Math.max(
                  held.startMs + held.durationMs,
                  window.startMs + share * (at + 1),
                );
          lines.push({
            actId: act.id,
            clip: createTextClip(words, trackId, startMs, endMs - startMs),
          });
        });
      }
    }
  }
  return lines;
}

/**
 * Where each shot of an act lands on the timeline, and how long it holds it.
 *
 * A shot made by act has its own place; a shot made by keyframe begins where
 * its own clip does. A shot the plan left out is not in the answers, and its
 * words are not placed either — a caption with no picture under it is worse
 * than a missing one.
 */
export function shotWindows(
  story: StoryDocument,
  act: StoryAct,
  units: AssemblyUnit[],
): Map<string, { startMs: number; durationMs: number }> {
  const windows = new Map<string, { startMs: number; durationMs: number }>();
  const perShot = story.shotGranularity === "keyframe";
  const actUnit = units.find(
    (unit) => unit.actId === act.id && unit.keyframeId === undefined,
  );
  let planned = 0;
  for (const keyframe of act.keyframes) {
    if (perShot) {
      const unit = units.find((held) => held.keyframeId === keyframe.id);
      if (unit !== undefined) {
        windows.set(keyframe.id, {
          startMs: unit.startMs,
          durationMs: unit.durationMs,
        });
      }
    } else if (actUnit !== undefined) {
      // An act filmed in one piece is cut where its board says its shots end:
      // the window a line is read in is the shot's own, whether or not the
      // material came back exactly as long as it was asked for.
      windows.set(keyframe.id, {
        startMs: actUnit.startMs + planned,
        durationMs: keyframe.durationMs,
      });
    }
    planned += keyframe.durationMs;
  }
  return windows;
}

/**
 * One line beside the assemble button: what this plan would do.
 *
 * The order is said out loud because it is the telling's own and not the
 * reader's to arrange here — a story is laid down episode by episode, and the
 * cutting room is where it is argued with.
 */
export function assemblySummary(
  story: StoryDocument,
  plan: AssemblyPlan,
): string {
  return i18n.t(
    story.shotGranularity === "keyframe"
      ? "story:edit.summaryByShot"
      : "story:edit.summary",
    {
      name: story.name,
      count: plan.units.length,
      seconds: (plan.totalPlannedMs / 1000).toFixed(1),
    },
  );
}

/**
 * What an assembly would lay down, counted: the readings and the score.
 *
 * The card says what a film will carry before it is made, and the numbers come
 * from the same plan the assembly itself is made of, so a line added since the
 * last assembly is counted before anybody presses anything.
 */
export function assemblyCarries(
  story: StoryDocument,
  moka: MokaFile,
  plan: AssemblyPlan,
): { voices: number; music: number } {
  const dubbing = planDubbing(
    story,
    plan.units,
    (assetId) => findResource(moka, assetId)?.probe?.durationMs,
  );
  return {
    voices: dubbing.cues.length,
    music: soundCues(story, plan).filter((cue) => cue.kind === "music").length,
  };
}

/**
 * What an assembly would lay down, as one short reading of it.
 *
 * Every clip the plan would write is written out in the order it lands — the
 * pictures, the readings, the score, the words — and the whole of it is hashed:
 * two assemblies with the same digest would put the same film on the timeline.
 * What a reader does to that timeline afterwards is theirs and is not in here,
 * so the digest can say whether the film is behind the telling without saying
 * anything about the cutting room.
 */
export function assemblyDigest(
  story: StoryDocument,
  moka: MokaFile,
  plan: AssemblyPlan,
  options: { withSubtitles: boolean; timelineId?: string },
): string {
  const size = timelineSizeForAspect(story.brief.aspect);
  const rows = [
    "assembly:v1",
    `timeline:${options.timelineId ?? "new"}`,
    `frame:${size.width}x${size.height}@${ASSEMBLY_FPS}`,
    `subtitles:${options.withSubtitles ? "on" : "off"}`,
  ];
  for (const unit of plan.units) {
    rows.push(
      `unit:${unit.actId}:${unit.keyframeId ?? ""}:${unit.startMs}:${unit.durationMs}:${unit.assetId}`,
    );
  }
  // The readings, which are the plan's own arithmetic read a second time: the
  // same windows, the same speeds, the same files, said as text.
  const dubbing = planDubbing(
    story,
    plan.units,
    (assetId) => findResource(moka, assetId)?.probe?.durationMs,
  );
  for (const cue of dubbing.cues) {
    rows.push(
      `voice:${cue.actId}:${cue.keyframeId}:${cue.lineId}:${cue.startMs}:${cue.durationMs}:${cue.speed}:${cue.assetId}`,
    );
  }
  for (const cue of soundCues(story, plan)) {
    rows.push(
      `${cue.kind}:${cue.actId}::${cue.startMs}:${cue.take.assetIds[0]}`,
    );
  }
  if (options.withSubtitles) {
    // The words are the captions' own; the row only needs where each of them
    // begins and how long it holds, which is what the captions decide.
    for (const line of captions(story, plan, dubbing.cues, "digest")) {
      rows.push(
        `caption:${line.actId}:${line.clip.startMs}:${line.clip.durationMs}:${line.clip.text?.content ?? ""}`,
      );
    }
  }
  return fnv1a(rows.join("\n"));
}
