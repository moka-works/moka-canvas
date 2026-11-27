/**
 * The speakers' own recordings, carried beside a clip.
 *
 * A video service that declares `audioReference` reads a recording of a
 * speaker's voice beside the pictures and copies its timbre and delivery for
 * that speaker's lines. The telling already holds one recording per character
 * card, so a clip asks for them itself: the speakers of the piece, in the
 * order they first speak, numbered with the same stable id the prompt gives
 * their lines. Nothing here is a reader's choice — a recording rides when the
 * model can read one and the clip is short enough for the service to hear it.
 *
 * The cap is the service's, not the board's: 277 frames at 24 fps, which is
 * eleven seconds. A longer piece is filmed without the recordings, and the
 * caller says why rather than quietly dropping them.
 */
import type { AssetId } from "../../../shared/domain";
import type {
  StoryAct,
  StoryDialogueLine,
  StoryDocument,
} from "../../../shared/domain/types";
import { characterRefs } from "../../../shared/prompts/story/promptContext";
import type { StorySpeakerIds } from "../../../shared/prompts";
import {
  effectiveDefaultId,
  protocolFeatures,
} from "../../settings/modelStore";
import { useModelStore } from "../../settings/modelStore";
import { storyAskModels } from "../stores/storyModels";
import { AUDIO_REFERENCE_SECONDS } from "../../../shared/domain/constants";

/** One recording a clip carries, and whose voice it is. */
export interface VoiceReference {
  /** The speaker's stable id: `S1`, `S2`, … */
  speaker: string;
  /** The character's name, as the reader reads it. */
  name: string;
  assetId: AssetId;
}

/** At most this many recordings travel: the service reads no more. */
const MAX_VOICE_REFERENCES = 3;

/** The paragraph that tells the service which speaker each recording voices. */
const VOICE_REFERENCE_MARKER = "Voice references:";

/**
 * Whether the whole clip's recording set can ride: a recording is useless
 * beside a clip too long for the service to hear it.
 */
function clipFits(seconds: number): boolean {
  return (
    Number.isFinite(seconds) &&
    seconds > 0 &&
    seconds <= AUDIO_REFERENCE_SECONDS
  );
}

/**
 * The character a line belongs to, by id first and by the name it is called
 * when the board kept no id.
 */
function speakerElement(
  story: StoryDocument,
  line: StoryDialogueLine,
): StoryDocument["elements"][number] | undefined {
  const byId =
    line.characterId === undefined
      ? undefined
      : story.elements.find(
          (element) =>
            element.id === line.characterId && element.kind === "character",
        );
  return (
    byId ??
    story.elements.find(
      (element) =>
        element.kind === "character" && element.name === line.speaker.trim(),
    )
  );
}

/** Every character's stable id, by element id and by the name a line calls. */
export function voiceSpeakerIds(story: StoryDocument): StorySpeakerIds {
  const byCharacter = characterRefs(story);
  const byName = new Map<string, string>();
  for (const element of story.elements) {
    const reference = byCharacter.get(element.id);
    if (reference !== undefined) byName.set(element.name, reference);
  }
  return { byCharacter, byName };
}

/**
 * The recordings a clip can carry: one per speaking character who has one on
 * file, in the order the speakers first speak, at most three.
 */
export function voiceReferencesFor(
  story: StoryDocument,
  lines: Iterable<StoryDialogueLine>,
): VoiceReference[] {
  const refs = characterRefs(story);
  const order: string[] = [];
  for (const line of lines) {
    if (line.text.trim() === "") continue;
    const element = speakerElement(story, line);
    if (element === undefined) continue;
    if (!order.includes(element.id)) order.push(element.id);
  }
  const found: VoiceReference[] = [];
  for (const id of order) {
    const element = story.elements.find((held) => held.id === id);
    const assetId = element?.voice?.referenceAssetId;
    const speaker = refs.get(id);
    if (element === undefined || assetId === undefined || speaker === undefined)
      continue;
    found.push({ speaker, name: element.name, assetId });
    if (found.length === MAX_VOICE_REFERENCES) break;
  }
  return found;
}

/** Whether one video model's converter reads a recording beside a clip. */
export function videoModelTakesVoiceReferences(model: string): boolean {
  const { view, protocols } = useModelStore.getState();
  const held = view?.models.find((each) => each.id === model);
  if (held === undefined) return false;
  return protocolFeatures(protocols, held.protocol).audioReference === true;
}

/**
 * The video models that may film this act: the one it names, or the step's
 * list, or the deployment's own default where the list is empty.
 *
 * The deployment default is read as this machine holds it rather than asked
 * for: the ask goes out without a model name when the room names none.
 */
export function actVideoCandidates(act: StoryAct): string[] {
  const own = (act.videoModel ?? "").trim();
  if (own !== "") return [own];
  const pool = storyAskModels("actVideo");
  if (pool.length > 0) return pool;
  const fallback = effectiveDefaultId(useModelStore.getState().view, "video");
  return fallback === null ? [] : [fallback];
}

/** Whether any model that may film this act reads a recording. */
export function anyActVideoCandidateTakesVoiceReferences(
  act: StoryAct,
): boolean {
  return actVideoCandidates(act).some(videoModelTakesVoiceReferences);
}

/**
 * The model an ask carrying recordings is sent to.
 *
 * A chosen model that reads them keeps the piece. One that does not is
 * replaced by the first candidate that does, so a list mixing models of
 * different abilities still films the clip with the speaker's voice. `null`
 * stands for the deployment's default, and is kept when that default itself
 * reads a recording.
 */
export function audioCapableVideoModel(
  act: StoryAct,
  chosen: string | null,
): string | null {
  if (chosen !== null && videoModelTakesVoiceReferences(chosen)) return chosen;
  const own = (act.videoModel ?? "").trim();
  if (own !== "" && videoModelTakesVoiceReferences(own)) return own;
  const found = storyAskModels("actVideo").find(videoModelTakesVoiceReferences);
  if (found !== undefined) return found;
  if (chosen === null) {
    const fallback = effectiveDefaultId(useModelStore.getState().view, "video");
    if (fallback === null || videoModelTakesVoiceReferences(fallback))
      return null;
    return null;
  }
  return chosen;
}

/** Whether one planned ask already carries a recording. */
export function carriesVoiceReferences(item: {
  inputs?: ReadonlyArray<{ role: string }>;
}): boolean {
  return (item.inputs ?? []).some((input) => input.role === "referenceAudio");
}

export type VoiceReferenceState =
  | { state: "on"; voices: VoiceReference[] }
  | { state: "noRecording" }
  | { state: "noModel" }
  | { state: "tooLong"; voices: VoiceReference[] };

/**
 * What a clip's voice recordings are doing, for the caller that has to say it.
 *
 * A place with no recorded speaker, a model that reads no recordings, and a
 * piece longer than the service hears are three different repairs, so they
 * are three different answers rather than one silence.
 */
export function voiceReferenceState(
  story: StoryDocument,
  lines: Iterable<StoryDialogueLine>,
  seconds: number,
  act: StoryAct,
): VoiceReferenceState {
  const voices = voiceReferencesFor(story, lines);
  if (voices.length === 0) return { state: "noRecording" };
  if (!anyActVideoCandidateTakesVoiceReferences(act))
    return { state: "noModel" };
  if (!clipFits(seconds)) return { state: "tooLong", voices };
  return { state: "on", voices };
}

/** The sentence mapping each recording to the speaker it voices. */
export function voiceReferencesParagraph(
  voices: ReadonlyArray<{ speaker: string }>,
): string {
  const sentences = voices.map(
    (voice, at) =>
      `<Audio ${at + 1}> carries the voice of the speaker labelled (${voice.speaker}); use its timbre, accent and delivery for every line that speaker says.`,
  );
  return `${VOICE_REFERENCE_MARKER} ${sentences.join(" ")}\n`;
}

/** A prompt with the voice mapping taken back out, where it was ours. */
export function stripVoiceReferences(prompt: string): string {
  const kept = prompt
    .split("\n")
    .filter((line) => !line.startsWith(VOICE_REFERENCE_MARKER));
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/**
 * The prompt with the voice mapping inside the description the service reads:
 * after the description header where the contract names one, before the
 * soundscape where it comes next, and at the end otherwise. The same insertion
 * the Rust planner makes, so a plan is the same plan whichever half made it.
 */
export function withVoiceReferences(
  prompt: string,
  voices: ReadonlyArray<{ speaker: string }>,
): string {
  if (voices.length === 0) return prompt;
  const base = stripVoiceReferences(prompt);
  const paragraph = voiceReferencesParagraph(voices);
  const header = base.indexOf("integrated_multimodal_description:");
  if (header !== -1) {
    const lineEnd = base.indexOf("\n", header);
    const end = lineEnd === -1 ? base.length : lineEnd + 1;
    return `${base.slice(0, end)}\n${paragraph}${base.slice(end)}`;
  }
  const soundscape = base.indexOf("overall_soundscape:");
  if (soundscape !== -1) {
    return `${base.slice(0, soundscape)}${paragraph}\n${base.slice(soundscape)}`;
  }
  return `${base}\n\n${paragraph}`;
}

/** The paragraph already on a prompt, replaced by the same for these voices. */
export function refreshVoiceReferences(
  prompt: string,
  voices: ReadonlyArray<{ speaker: string }> | undefined,
): string {
  if (voices === undefined || voices.length === 0) return prompt;
  // A rewrite that kept the mapping already names every recording; appending
  // the canonical lines again would say it twice.
  const kept = voices.every((_, at) => prompt.includes(`<Audio ${at + 1}>`));
  if (kept) return prompt;
  return withVoiceReferences(prompt, voices);
}
