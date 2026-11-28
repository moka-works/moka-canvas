/**
 * Laying one episode's shots end to end as a timeline of its own.
 *
 * Everything here is arithmetic over the document: which clips the fourth step
 * has made, in what order they go, where each of them lands, and what one
 * `execute` has to write to put them there. Nothing reads a store or asks a
 * server, so what an assembly will do is the same answer in a test, in the
 * warning a reader is shown, and in the commands that are finally written.
 *
 * An episode is assembled twice over in the ordinary run of things — once when
 * its clips are first cut, and again every time another act is filmed — so what
 * goes on the timeline is planned first and looked at before it is applied, and
 * an assembly with nothing to lay down is refused rather than written empty.
 * Each episode's plan and cut stay blind to the episodes beside them.
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
  actGranularity,
  actPlannedMs,
  chapterCut,
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
  StoryChapter,
  StoryChapterCut,
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
  /** Where the window the take keeps opens in this file. */
  inPointMs: number;
  /** Where it closes in this file. */
  outPointMs: number;
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
  /** The take those files are, with the window the reader cut it to. */
  take: StoryTake | undefined;
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
  // A bridge is one clip whatever the telling's habit: the move itself.
  if (act.transition !== undefined) {
    const take = currentTake(act.video);
    return [
      {
        assetIds: take?.assetIds ?? [],
        plannedMs: act.transition.durationMs,
        take,
      },
    ];
  }
  if (actGranularity(act, story.shotGranularity) === "keyframe") {
    return act.keyframes.map((keyframe) => {
      const take = currentTake(keyframe.video);
      const file = takeFile(take);
      return {
        keyframe,
        assetIds: file === undefined ? [] : [file],
        plannedMs: keyframe.durationMs,
        take,
      };
    });
  }
  const take = currentTake(act.video);
  return [
    {
      assetIds: take?.assetIds ?? [],
      plannedMs: actPlannedMs(act),
      take,
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
  acts: StoryAct[],
  tracks: TimelineDocument["tracks"],
): {
  rows: { voice?: string; music?: string };
  added: TimelineTrack[];
} {
  const voiced = acts.some(
    (act) => act.voice !== undefined || readPerLine(act),
  );
  const scored = acts.some((act) => act.music !== undefined);
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
  chapterId?: string,
): AssemblyPlan {
  const units: AssemblyUnit[] = [];
  const warnings: AssemblyWarning[] = [];
  let at = 0;

  story.chapters.forEach((chapter, chapterAt) => {
    if (chapterId !== undefined && chapter.id !== chapterId) return;
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
        const parts = shot.assetIds.map((assetId) => {
          const resource = findResource(moka, assetId);
          if (resource === undefined) {
            // An asset the document no longer holds cannot be laid on a track:
            // the clip would be a hole with a name. Saying which one is the
            // useful part of finding out.
            warnings.push({ kind: "assetMissing", ...where });
          } else if (resource.probe?.durationMs === undefined) {
            warnings.push({ kind: "noDuration", ...where });
          }
          return {
            assetId,
            resource,
            durationMs:
              resource === undefined ? share : lengthOf(resource, share),
          };
        });
        // The window the take was cut to runs across the pieces in play order;
        // the whole take is what a take with no window says.
        const fullMs = parts.reduce((sum, part) => sum + part.durationMs, 0);
        const windowIn = Math.min(Math.max(shot.take?.inMs ?? 0, 0), fullMs);
        const windowOut = Math.min(
          Math.max(shot.take?.outMs ?? fullMs, windowIn),
          fullMs,
        );
        let pieceAt = 0;
        for (const part of parts) {
          const pieceStart = pieceAt;
          pieceAt += part.durationMs;
          if (part.resource === undefined) continue;
          const inPoint = Math.max(windowIn, pieceStart);
          const outPoint = Math.min(windowOut, pieceStart + part.durationMs);
          if (outPoint <= inPoint) continue;
          const durationMs = outPoint - inPoint;
          units.push({
            actId: act.id,
            ...(shot.keyframe === undefined
              ? {}
              : { keyframeId: shot.keyframe.id }),
            chapterIndex: chapterAt + 1,
            actIndex: actAt + 1,
            startMs: at,
            durationMs,
            inPointMs: inPoint - pieceStart,
            outPointMs: outPoint - pieceStart,
            assetId: part.assetId,
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

/** Where an episode opens on the assembled timeline, when it holds a unit. */
export function chapterStartMs(
  plan: AssemblyPlan,
  chapterIndex: number,
): number | undefined {
  return plan.units.find((unit) => unit.chapterIndex === chapterIndex)?.startMs;
}

/** The acts a plan actually lays something down for, in telling order. */
function actsOfPlan(story: StoryDocument, plan: AssemblyPlan): StoryAct[] {
  const wanted = new Set(plan.units.map((unit) => unit.actId));
  return story.chapters
    .flatMap((chapter) => chapter.acts)
    .filter((act) => wanted.has(act.id));
}

/**
 * What assembling one episode writes, as the one batch of commands it is.
 *
 * An episode assembled for the first time brings a timeline of its own with
 * it; one assembled again edits that same timeline — taking back only the
 * clips this episode's assembly laid down itself, so a reader's own work on
 * the same track is left where it stands. Either way it is one step of the
 * history, because it is one thing the reader asked for.
 */
export function assemblyCommands(
  story: StoryDocument,
  moka: MokaFile,
  plan: AssemblyPlan,
  options: {
    withSubtitles: boolean;
    cut?: StoryChapterCut;
    timelineName?: string;
  },
): {
  commands: DocumentCommand[];
  clipByAct: NonNullable<StoryEdit["clipByAct"]>;
  timelineId: string;
} {
  if (plan.units.length === 0) {
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("story:edit.nothingToAssemble"),
    );
  }
  const size = timelineSizeForAspect(story.brief.aspect);
  const target =
    options.cut === undefined
      ? undefined
      : (moka.timelines ?? []).find(
          (held) => held.id === options.cut?.timelineId,
        );
  const acts = actsOfPlan(story, plan);

  if (target === undefined) {
    const timeline = createTimeline(options.timelineName ?? story.name, {
      width: size.width,
      height: size.height,
      fps: ASSEMBLY_FPS,
      background: ASSEMBLY_BACKGROUND,
    });
    // A timeline this episode is making can have its rows named for what they
    // carry; one a reader has worked on keeps whatever names it was given.
    const sound = soundRows(acts, timeline.tracks);
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
      timelineId: timeline.id,
    };
  }

  // A timeline that has lost its video row cannot carry a film: a fresh one is
  // made rather than an episode quietly laid down on the sound track.
  if (target.tracks.every((track) => track.kind !== "video")) {
    const timeline = createTimeline(options.timelineName ?? story.name, {
      width: size.width,
      height: size.height,
      fps: ASSEMBLY_FPS,
      background: ASSEMBLY_BACKGROUND,
    });
    return {
      commands: [{ type: "addTimeline", timeline: { ...timeline, clips: [] } }],
      clipByAct: [],
      timelineId: timeline.id,
    };
  }

  const sound = soundRows(acts, target.tracks);
  const { clips, clipByAct } = layDown(story, moka, plan, {
    tracks: [...target.tracks, ...sound.added],
    rows: sound.rows,
    withSubtitles: options.withSubtitles,
  });

  const commands: DocumentCommand[] = [];
  // Only what this episode's assembly put there: a clip the reader added by
  // hand is not this episode's to take away.
  const mine = (options.cut?.clipByAct ?? [])
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
  return { commands, clipByAct, timelineId: target.id };
}

/**
 * One episode's cut, copied onto a timeline of the reader's own naming.
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
  chapter: StoryChapter,
  name: string,
): { commands: DocumentCommand[]; timelineId: string; clips: number } {
  const cut = chapterCut(story, chapter.id);
  if (cut === undefined) {
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("story:import.timeline.notAssembled"),
    );
  }
  const source = (moka.timelines ?? []).find(
    (timeline) => timeline.id === cut.timelineId,
  );
  if (source === undefined) {
    throw new CommandError(
      "TIMELINE_NOT_FOUND",
      i18n.t("story:edit.noTimeline"),
    );
  }
  // A standing timeline is added whole, which is the one way clips land without
  // the command that counts them — so the ceiling a cut holds is asked here
  // rather than discovered by a document that would carry more than it may.
  if (source.clips.length > MAX_CLIPS_PER_TIMELINE) {
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("story:import.tooManyClips", { max: MAX_CLIPS_PER_TIMELINE }),
    );
  }
  const now = nowIso();
  const tracks = source.tracks.map((track) => ({ ...track, id: newId() }));
  const trackIds = new Map(
    source.tracks.map((track, at) => [track.id, tracks[at]!.id]),
  );
  const clips = source.clips.map((clip) => {
    const id = newId();
    return {
      ...clip,
      id,
      trackId: trackIds.get(clip.trackId) ?? clip.trackId,
      createdAt: now,
      updatedAt: now,
    };
  });
  const clipIds = new Map(
    source.clips.map((clip, at) => [clip.id, clips[at]!.id]),
  );
  const transitions = source.transitions.flatMap((transition) => {
    const afterClipId = clipIds.get(transition.afterClipId);
    return afterClipId === undefined
      ? []
      : [{ ...transition, id: newId(), afterClipId }];
  });
  const markers = source.markers?.map((marker) => ({ ...marker, id: newId() }));
  const timeline: TimelineDocument = {
    ...source,
    id: newId(),
    name,
    tracks,
    clips,
    transitions,
    ...(markers === undefined ? {} : { markers }),
    createdAt: now,
    updatedAt: now,
  };
  return {
    commands: [{ type: "addTimeline", timeline }],
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
      inPointMs: unit.inPointMs,
      outPointMs: unit.outPointMs,
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
 * voice. It never runs into the line that follows: the next line's start is the
 * hard end, so a long reading cannot write one caption over another.
 */
function captions(
  story: StoryDocument,
  plan: AssemblyPlan,
  cues: DubCue[],
  trackId: string,
): Array<{ actId: string; clip: TimelineClip }> {
  interface Draft {
    actId: string;
    words: string;
    startMs: number;
    endMs: number;
  }
  const drafts: Draft[] = [];
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
          drafts.push({ actId: act.id, words, startMs, endMs });
        });
      }
    }
  }
  const lines: Array<{ actId: string; clip: TimelineClip }> = [];
  drafts.forEach((draft, at) => {
    const next = drafts[at + 1];
    const endMs =
      next === undefined ? draft.endMs : Math.min(draft.endMs, next.startMs);
    if (endMs <= draft.startMs) return;
    lines.push({
      actId: draft.actId,
      clip: createTextClip(
        draft.words,
        trackId,
        draft.startMs,
        endMs - draft.startMs,
      ),
    });
  });
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
  const perShot = actGranularity(act, story.shotGranularity) === "keyframe";
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
  chapter?: StoryChapter,
): string {
  const anyPerShot = (chapter === undefined ? story.chapters : [chapter]).some(
    (held) =>
      held.acts.some(
        (act) => actGranularity(act, story.shotGranularity) === "keyframe",
      ),
  );
  const number =
    chapter === undefined
      ? undefined
      : story.chapters.findIndex((held) => held.id === chapter.id) + 1;
  const key =
    chapter === undefined
      ? anyPerShot
        ? "story:edit.summaryByShot"
        : "story:edit.summary"
      : anyPerShot
        ? "story:edit.summaryChapterByShot"
        : "story:edit.summaryChapter";
  return i18n.t(key, {
    name: story.name,
    ...(chapter === undefined ? {} : { chapter: number, title: chapter.title }),
    count: plan.units.length,
    seconds: (plan.totalPlannedMs / 1000).toFixed(1),
  });
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
  _moka: MokaFile,
  plan: AssemblyPlan,
  options: { withSubtitles: boolean; timelineId?: string },
): string {
  const size = timelineSizeForAspect(story.brief.aspect);
  const rows = [
    "assembly:v2",
    `timeline:${options.timelineId ?? "new"}`,
    `frame:${size.width}x${size.height}@${ASSEMBLY_FPS}`,
    `subtitles:${options.withSubtitles ? "on" : "off"}`,
  ];
  for (const unit of plan.units) {
    rows.push(
      `unit:${unit.actId}:${unit.keyframeId ?? ""}:${unit.startMs}:${unit.durationMs}:${unit.assetId}`,
    );
  }
  // What this assembly would lay down, not what the rest of the telling holds:
  // an episode's digest has to be blind to the episodes beside it, or filming
  // another one would make this one look behind.
  const acts = new Set(plan.units.map((unit) => unit.actId));
  for (const chapter of story.chapters) {
    for (const act of chapter.acts) {
      if (!acts.has(act.id)) continue;
      const perLine = act.keyframes.some((keyframe) =>
        keyframe.dialogue.some(
          (line) => voiceTakeOf(keyframe, line.id) !== undefined,
        ),
      );
      if (perLine) {
        for (const keyframe of act.keyframes) {
          for (const line of keyframe.dialogue) {
            const assetId = takeFile(
              currentTake(
                voiceTakeOf(keyframe, line.id)?.slot ?? emptyStorySlot(),
              ),
            );
            if (assetId !== undefined) {
              rows.push(`voice:${act.id}:${keyframe.id}:${line.id}:${assetId}`);
            }
          }
        }
      } else {
        const assetId = takeFile(currentTake(act.voice ?? emptyStorySlot()));
        if (assetId !== undefined) rows.push(`voice:${act.id}:::${assetId}`);
      }
      const music = takeFile(currentTake(act.music ?? emptyStorySlot()));
      if (music !== undefined) rows.push(`music:${act.id}::${music}`);
      if (options.withSubtitles) {
        for (const keyframe of act.keyframes) {
          for (const line of keyframe.dialogue) {
            if (line.text.trim() === "") continue;
            rows.push(
              `caption:${act.id}:${keyframe.id}:${line.id ?? ""}:${line.text}`,
            );
          }
        }
      }
    }
  }
  return fnv1a(rows.join("\n"));
}
