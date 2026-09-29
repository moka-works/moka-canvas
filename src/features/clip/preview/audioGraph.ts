import type {
  AssetId,
  ClipId,
  TimelineClip,
  TimelineDocument,
  TimelineTrack,
} from "../../../shared/domain";
import { assetUrl } from "../../../api";
import { useAppStore } from "../../editor/stores/appStore";
import { i18n } from "../../../shared/i18n";
import { useClipStore } from "../stores/clipStore";
import { seamAt, type SeamMoment } from "./blend";
import { fadeFactor, materialMoment } from "./compositor";

/**
 * The cut's sound, made of media elements rather than decoded samples.
 *
 * A ten-minute stereo file decoded whole is a few hundred megabytes of
 * samples this room never looks at; each clip that can be heard instead gets
 * a hidden `<audio>` element pointed at its own material — a video's own
 * sound reads the same way — and the element's stream is voiced through a
 * short chain: the clip's level (volume × fades × mute) into its track's mute
 * into the master. At most four sound at once, the ones nearest the playhead;
 * a seam window's two sides cross through the same one place (10 §4).
 *
 * The clock never waits on any of this. A browser that will not start audio
 * is a silent preview, not a stopped one, and a file it will not play is one
 * clip's silence rather than the cut's.
 */

/**
 * The level a clip's own sound carries at a moment: its volume times its two
 * fades, and nothing when the clip or its track is muted.
 *
 * The one reading the preview and, later, the export agree on — the ramps the
 * engine schedules are this curve sampled at the moment a voice starts.
 */
export function clipGainAt(
  clip: TimelineClip,
  track: TimelineTrack | null,
  atMs: number,
): number {
  if (clip.muted || track?.muted) return 0;
  return Math.max(0, clip.volume) * fadeFactor(clip, atMs);
}

/** Which side of a seam window a sounding clip is. */
export type TransitionRole = "leader" | "follower";

/**
 * The share a seam window gives one of its sides at a moment, linear from end
 * to end: the leader hands over as the follower takes up, both at full level
 * exactly at the window's ends. A null progress is a moment outside every
 * window, which leaves the level alone at 1.
 *
 * The same curve is reproduced in an export by one linear `afade` on each
 * side (10 §8), so this is the one reading both sides of the cut share.
 */
export function transitionGain(
  progress: number | null,
  role: TransitionRole,
): number {
  if (progress === null) return 1;
  return role === "leader" ? 1 - progress : progress;
}

/** The seam window a track has open at a moment, or null. */
function seamWindowAt(
  timeline: TimelineDocument | null,
  trackId: string,
  atMs: number,
): SeamMoment | null {
  return timeline ? seamAt(timeline, trackId, atMs) : null;
}

/**
 * How far a source may drift from the clock before it is pulled back, in
 * milliseconds.
 *
 * The plan's own pair of readings sits on this edge: a hundred-millisecond
 * miss is corrected, half of one is left running.
 */
export const RESYNC_THRESHOLD_MS = 100;

/**
 * Whether a source's own play position has drifted far enough to correct.
 *
 * Small differences are left alone: a correction that fired on every check
 * would be an audible stutter, and the ear only notices a tenth of a second,
 * so anything inside that band is better left running.
 */
export function needsResync(expectedMs: number, actualMs: number): boolean {
  return Math.abs(expectedMs - actualMs) >= RESYNC_THRESHOLD_MS;
}

/** How often a sounding source's position is checked against the clock. */
export const RESYNC_INTERVAL_MS = 250;

/** The most elements that may sound at once. */
export const MAX_VOICES = 4;

/** A clip that can be heard at a moment, with the row it sits on. */
export interface AudibleClip {
  clip: TimelineClip;
  track: TimelineTrack;
}

/**
 * The clips whose sound covers a moment, nearest the playhead first, at most
 * four of them.
 *
 * A row sounds what it shows: outside a seam window that is its one clip,
 * and inside one it is both — the window is exactly where the two sides cross
 * (its own gains are applied when the voices are levelled). Words are words,
 * so text rows are left out, and a muted clip or a muted row is left out
 * whole rather than voiced at zero.
 */
export function audibleClipsAt(
  timeline: TimelineDocument,
  atMs: number,
): AudibleClip[] {
  const sounding: AudibleClip[] = [];
  for (const track of timeline.tracks) {
    if (track.muted) continue;
    for (const clip of timeline.clips) {
      if (clip.trackId !== track.id) continue;
      if (clip.kind === "text" || !clip.assetId) continue;
      if (clip.muted || clip.volume <= 0) continue;
      if (atMs < clip.startMs || atMs >= clip.startMs + clip.durationMs)
        continue;
      sounding.push({ clip, track });
    }
  }
  // Nearest first: the clip the playhead walked into most recently is the one
  // whose voice matters, and the four nearest are all that sound.
  sounding.sort((a, b) => b.clip.startMs - a.clip.startMs);
  return sounding.slice(0, MAX_VOICES);
}

/** One element and the gain chain its sound passes through. */
interface Voice {
  element: HTMLAudioElement;
  clipGain: GainNode;
  trackGain: GainNode;
  clipId: ClipId | null;
  assetId: AssetId | null;
  clip: TimelineClip | null;
  track: TimelineTrack | null;
  /** When this voice's position was last checked against the clock. */
  checkedAt: number;
}

let context: AudioContext | null = null;
let master: GainNode | null = null;
const voices: Voice[] = [];
let timeline: TimelineDocument | null = null;
let playing = false;
let silentReported = false;
/** Where the clock last stood, so a document change can rebuild in place. */
let lastPlayhead = 0;

/** The one context, made inside the first gesture that asks for sound. */
function audioContext(): AudioContext | null {
  if (context) return context;
  if (typeof AudioContext === "undefined") return null;
  try {
    context = new AudioContext();
    master = context.createGain();
    // The level the reader left the slider at, applied when the graph starts.
    master.gain.value = useClipStore.getState().masterVolume;
    master.connect(context.destination);
  } catch {
    // A browser that will not give a context gives silence, not an error.
    context = null;
    master = null;
  }
  return context;
}

/** Said once a session: silence is worth one word, not a toast per frame. */
function reportSilent(): void {
  if (silentReported) return;
  silentReported = true;
  useAppStore.getState().pushToast("info", i18n.t("clip:preview.silent"));
}

function makeVoice(ctx: AudioContext): Voice | null {
  if (typeof document === "undefined") return null;
  let element: HTMLAudioElement;
  let node: MediaElementAudioSourceNode;
  try {
    element = document.createElement("audio");
    // A voice is pointed at a whole 27–37MB picture file, and four voices can
    // hold three of them: told to preload everything, the elements spend the
    // cut's six connections fetching minutes of sound nobody will hear. The
    // file is asked for as the voice is assigned — the position is set and it
    // plays — which is enough for a source that starts where the clock stands.
    element.preload = "metadata";
    node = ctx.createMediaElementSource(element);
  } catch {
    // A document that will not hand out media elements is one that cannot
    // sound; the clock runs on regardless.
    return null;
  }
  const clipGain = ctx.createGain();
  const trackGain = ctx.createGain();
  node.connect(clipGain);
  clipGain.connect(trackGain);
  if (master) trackGain.connect(master);
  const voice: Voice = {
    element,
    clipGain,
    trackGain,
    clipId: null,
    assetId: null,
    clip: null,
    track: null,
    checkedAt: 0,
  };
  return voice;
}

/** An element that is not voicing anything at this moment, or a new one. */
function takeVoice(ctx: AudioContext): Voice | null {
  const idle = voices.find((voice) => voice.clipId === null);
  if (idle) return idle;
  const made = makeVoice(ctx);
  if (made) voices.push(made);
  return made;
}

function stopVoice(voice: Voice): void {
  try {
    voice.element.pause();
  } catch {
    // An element that cannot pause is one that was never playing.
  }
  // The voice lets its file go rather than keeping it warm: paused but
  // pointed at a 30MB picture, the element goes on buffering it in the
  // background, and those fetches are what the next cut's first frame is
  // queued behind. An assigned voice is pointed again — the source is set
  // whenever the asset changes, and a released voice has none.
  voice.element.removeAttribute("src");
  try {
    voice.element.load();
  } catch {
    // A document that will not reload the element has still dropped the source.
  }
  voice.assetId = null;
  voice.clipId = null;
  voice.clip = null;
  voice.track = null;
}

/**
 * The role a clip plays in the window its track has open at a moment, or null
 * when the moment is outside every window.
 */
function roleInSeam(
  seam: SeamMoment | null,
  clip: TimelineClip,
): TransitionRole | null {
  if (!seam) return null;
  if (seam.leader.id === clip.id) return "leader";
  if (seam.follower.id === clip.id) return "follower";
  return null;
}

/** The ramps that carry a clip's volume and fades, planned from where the clock stands. */
function scheduleGain(
  ctx: AudioContext,
  voice: Voice,
  clip: TimelineClip,
  track: TimelineTrack,
  atMs: number,
): void {
  const now = ctx.currentTime;
  const param = voice.clipGain.gain;
  // An old plan must not argue with a new value: what was scheduled is taken
  // back before the new shape is laid down.
  param.cancelScheduledValues(now);
  const seam = seamWindowAt(timeline, track.id, atMs);
  const role = roleInSeam(seam, clip);
  if (seam && role) {
    // Inside a window the clip's own curve and the window's share multiply —
    // the one place the transition touches the sound, so no second gain path
    // exists (10 §4). The product is not a line, so it is anchored where the
    // voice takes over and where the window ends, where the share is exactly
    // 0 for the leader and 1 for the follower; a fade that outlives the
    // window is ramped on after it.
    const level = Math.max(0, clip.volume);
    const windowEndMs = Math.min(
      seam.follower.startMs + seam.transition.durationMs,
      clip.startMs + clip.durationMs,
    );
    param.setValueAtTime(
      clipGainAt(clip, track, atMs) * transitionGain(seam.progress, role),
      now,
    );
    param.linearRampToValueAtTime(
      role === "leader" ? 0 : clipGainAt(clip, track, windowEndMs),
      now + (windowEndMs - atMs) / 1_000,
    );
    const intoClipMs = atMs - clip.startMs;
    if (
      clip.fadeInMs > 0 &&
      clip.fadeInMs > intoClipMs + (windowEndMs - atMs)
    ) {
      // Linear, like the export's `afade`: the two sides trim the same curve.
      param.linearRampToValueAtTime(
        level,
        now + (clip.fadeInMs - intoClipMs) / 1_000,
      );
    }
    const untilEndMs = clip.startMs + clip.durationMs - atMs;
    if (clip.fadeOutMs > 0 && untilEndMs > windowEndMs - atMs) {
      param.linearRampToValueAtTime(0, now + untilEndMs / 1_000);
    }
    voice.trackGain.gain.value = track.muted ? 0 : 1;
    return;
  }
  param.setValueAtTime(clipGainAt(clip, track, atMs), now);
  const level = Math.max(0, clip.volume);
  const intoClipMs = atMs - clip.startMs;
  if (clip.fadeInMs > 0 && intoClipMs < clip.fadeInMs) {
    // Linear, like the export's `afade`: the two sides trim the same curve.
    param.linearRampToValueAtTime(
      level,
      now + (clip.fadeInMs - intoClipMs) / 1_000,
    );
  }
  const untilEndMs = clip.startMs + clip.durationMs - atMs;
  if (clip.fadeOutMs > 0 && untilEndMs < clip.fadeOutMs) {
    param.linearRampToValueAtTime(0, now + untilEndMs / 1_000);
  }
  voice.trackGain.gain.value = track.muted ? 0 : 1;
}

/** Points a voice at its clip and puts the element where the clock stands. */
function assign(voice: Voice, entry: AudibleClip, atMs: number): void {
  const { clip, track } = entry;
  const assetId = clip.assetId;
  if (!assetId) return;
  if (voice.assetId !== assetId) {
    // The element is recycled: the old file's sound is dropped and the new
    // one is fetched, which is the whole "pool of ≤4" in one line.
    voice.element.src = assetUrl(assetId);
    voice.assetId = assetId;
  }
  voice.clipId = clip.id;
  voice.clip = clip;
  voice.track = track;
  voice.element.playbackRate = clip.speed;
  // The export keeps the pitch with `atempo`; the preview must not part ways.
  voice.element.preservesPitch = true;
  const materialMs = materialMoment(clip, atMs);
  try {
    voice.element.currentTime = materialMs / 1_000;
  } catch {
    // A file that has not loaded yet takes its position from the seek it is
    // given once it has; the picture's clock is not held up for it.
  }
  voice.checkedAt = Date.now();
  if (context) scheduleGain(context, voice, clip, track, atMs);
  if (playing) {
    void voice.element.play().catch(() => {
      // A file the browser will not play is this clip's silence; the rest of
      // the cut is unaffected.
    });
  }
}

/** Puts every voice back and builds the set that should sound at a moment. */
function rebuild(atMs: number): void {
  const ctx = context;
  if (!ctx || !timeline) return;
  const wanted = audibleClipsAt(timeline, atMs);
  const kept = new Set<ClipId>();
  for (const entry of wanted) kept.add(entry.clip.id);
  for (const voice of voices) {
    if (voice.clipId === null) continue;
    if (!kept.has(voice.clipId)) stopVoice(voice);
  }
  for (const entry of wanted) {
    const voice = voices.find(
      (candidate) => candidate.clipId === entry.clip.id,
    );
    const target = voice ?? takeVoice(ctx);
    if (target) assign(target, entry, atMs);
  }
}

/** The drift of one sounding voice, and its correction when it has drifted. */
function checkDrift(voice: Voice, atMs: number): void {
  if (!voice.clip) return;
  const expectedMs = materialMoment(voice.clip, atMs);
  const actualMs = voice.element.currentTime * 1_000;
  if (needsResync(expectedMs, actualMs)) {
    // Hard correction, once: the element is pulled back to where the clock
    // stands rather than walked there, and left alone afterwards.
    try {
      voice.element.currentTime = expectedMs / 1_000;
    } catch {
      // A position the element will not take is one it does not hold yet.
    }
  }
  voice.checkedAt = Date.now();
}

export interface AudioEngine {
  /** The cut being heard; a document change is the same rebuild as an edit. */
  setTimeline(next: TimelineDocument | null): void;
  /** Starts sounding from a moment, building the audible set for it. */
  play(atMs: number): void;
  /** Stops every element: after this, nothing the engine holds is playing. */
  pause(): void;
  /** Repositions the audible set while stopped, so the next play starts right. */
  seek(atMs: number): void;
  /** The per-frame upkeep: clip boundaries and the drift check. */
  tick(atMs: number): void;
  setMasterVolume(volume: number): void;
  /** The leak check: after a pause, every element the engine holds is stopped. */
  allPaused(): boolean;
}

function engine(): AudioEngine {
  return {
    setTimeline(next) {
      timeline = next;
      if (playing) rebuild(lastPlayhead);
    },

    play(atMs) {
      const ctx = audioContext();
      if (ctx) {
        if (ctx.state !== "running") {
          void ctx.resume().then(
            () => {
              if (context?.state !== "running") reportSilent();
            },
            () => reportSilent(),
          );
        }
      }
      playing = true;
      lastPlayhead = atMs;
      rebuild(atMs);
    },

    pause() {
      playing = false;
      for (const voice of voices) stopVoice(voice);
    },

    seek(atMs) {
      if (playing) return;
      lastPlayhead = atMs;
      rebuild(atMs);
    },

    tick(atMs) {
      if (!playing || !context) return;
      lastPlayhead = atMs;
      // What should sound is the only reading that decides a rebuild: a clip
      // boundary moves the set, and so does a seam window opening (the
      // follower joins while the leader is still going) or closing.
      const wanted = timeline ? audibleClipsAt(timeline, atMs) : [];
      const sounding = new Set(
        voices
          .filter((voice) => voice.clipId !== null)
          .map((voice) => voice.clipId),
      );
      const same =
        wanted.length === sounding.size &&
        wanted.every((entry) => sounding.has(entry.clip.id));
      if (!same) {
        rebuild(atMs);
        return;
      }
      for (const voice of voices) {
        if (voice.clipId === null) continue;
        if (Date.now() - voice.checkedAt >= RESYNC_INTERVAL_MS)
          checkDrift(voice, atMs);
      }
    },

    setMasterVolume(volume) {
      if (master) master.gain.value = Math.min(1, Math.max(0, volume));
    },

    allPaused() {
      return voices.every((voice) => voice.element.paused);
    },
  };
}

/** The one engine, made on first use so a test without a DOM makes nothing. */
export function audioEngine(): AudioEngine {
  if (!shared) shared = engine();
  return shared;
}

let shared: AudioEngine | null = null;
