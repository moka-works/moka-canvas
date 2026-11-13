/**
 * The material a video prompt is written from, as the rewrite step reads it.
 *
 * A prompt's words are one reading of a board; this is the board itself — the
 * shots it holds, the lines they say, who says them, and what the act sounds
 * like — so a model asked to rewrite the words into another shape can keep
 * every fact the words carried rather than guess at them. Nothing here is
 * stored in the document: it is built where a clip is planned and travels
 * with the ask.
 */
import type {
  StoryAspect,
  StoryDialogueLine,
  StoryDocument,
  StoryElementKind,
  StoryKeyframe,
} from "../../domain/types";
import { stripStoryMentions } from "../../domain/story";

/** One speaker, and the stable id the contract calls them by. */
export interface PromptContextCast {
  name: string;
  /** `S1`, `S2`, … — the same across every clip of the telling. */
  ref: string;
  kind: StoryElementKind;
  description: string;
}

/** One line as it is said, and by whom. */
export interface PromptContextLine {
  speaker: string;
  /** The speaker's id, where the speaker is someone the board knows. */
  ref?: string;
  text: string;
  tone?: string;
}

/** One picture the clip is made of, as the board shows it. */
export interface PromptContextShot {
  text: string;
  /** Shot size, camera move and angle, as the board names them. */
  framing?: string;
  seconds?: number;
}

/** What the clip is: an act filmed whole, one shot, or a bridge between acts. */
export interface StoryPromptContext {
  kind: "act" | "shot" | "transition";
  aspect: StoryAspect;
  style: string;
  seconds: number;
  /** The pictures the ask travels with, and what they are for. */
  ends: { first: boolean; last: boolean; references: boolean };
  shots: PromptContextShot[];
  /** How a bridge moves from one act to the next. */
  transition?: { from: string; to: string; move: string };
  cast: PromptContextCast[];
  dialogue: PromptContextLine[];
  sound?: { music: string; sfx: string; ambience?: string };
  /** Its place among the pieces, when an act is filmed in several. */
  part?: number;
  total?: number;
}

/**
 * The id each character of a telling goes by, in the order the cast is kept.
 *
 * The numbering is the host's rather than the model's because the contract
 * asks for one id per speaker across the whole film: a model handed the same
 * cast twice would not necessarily number it the same way twice.
 */
export function characterRefs(story: StoryDocument): Map<string, string> {
  const refs = new Map<string, string>();
  let at = 0;
  for (const element of story.elements) {
    if (element.kind !== "character") continue;
    at += 1;
    refs.set(element.id, `S${at}`);
  }
  return refs;
}

/** The speaker's id, by the character they are or the name they are called. */
export function speakerRef(
  story: StoryDocument,
  refs: Map<string, string>,
  line: StoryDialogueLine,
): string | undefined {
  if (line.characterId !== undefined) {
    const held = refs.get(line.characterId);
    if (held !== undefined) return held;
  }
  const name = line.speaker.trim();
  if (name === "") return undefined;
  const element = story.elements.find(
    (each) => each.kind === "character" && each.name === name,
  );
  return element === undefined ? undefined : refs.get(element.id);
}

/**
 * The cast a clip's rewrite is told about: the characters standing in it and
 * everyone who speaks in it, each with their stable id.
 */
export function castFor(
  story: StoryDocument,
  characterIds: string[],
  lines: StoryDialogueLine[],
): PromptContextCast[] {
  const refs = characterRefs(story);
  const wanted = new Set(characterIds);
  for (const line of lines) {
    if (line.characterId !== undefined) wanted.add(line.characterId);
    else {
      const named = story.elements.find(
        (each) =>
          each.kind === "character" && each.name === line.speaker.trim(),
      );
      if (named !== undefined) wanted.add(named.id);
    }
  }
  return story.elements
    .filter((element) => element.kind === "character" && wanted.has(element.id))
    .flatMap((element) => {
      const ref = refs.get(element.id);
      if (ref === undefined) return [];
      return [
        {
          name: element.name,
          ref,
          kind: element.kind,
          description: element.description,
        },
      ];
    });
}

/** The lines a clip says, each with the id of the one who says it. */
export function linesFor(
  story: StoryDocument,
  refs: Map<string, string>,
  lines: StoryDialogueLine[],
): PromptContextLine[] {
  return lines
    .filter((line) => line.text.trim() !== "")
    .map((line) => {
      const ref = speakerRef(story, refs, line);
      return {
        speaker: line.speaker.trim(),
        ...(ref === undefined ? {} : { ref }),
        text: line.text.trim(),
        ...(line.tone === undefined || line.tone.trim() === ""
          ? {}
          : { tone: line.tone.trim() }),
      };
    });
}

/** The shots a clip covers, as the board describes them. */
export function shotsFor(keyframes: StoryKeyframe[]): PromptContextShot[] {
  return keyframes.map((keyframe) => ({
    text: stripStoryMentions(keyframe.content),
    framing: [keyframe.shotSize, keyframe.cameraMove, keyframe.angle].join(
      ", ",
    ),
    seconds: Math.round(keyframe.durationMs / 100) / 10,
  }));
}

/** What an act sounds like, where it sounds like anything. */
export function soundFor(sound: {
  music: string;
  sfx: string;
  ambience?: string;
}): StoryPromptContext["sound"] {
  const music = sound.music.trim();
  const sfx = sound.sfx.trim();
  const ambience = sound.ambience?.trim() ?? "";
  if (music === "" && sfx === "" && ambience === "") return undefined;
  return {
    music,
    sfx,
    ...(ambience === "" ? {} : { ambience }),
  };
}
