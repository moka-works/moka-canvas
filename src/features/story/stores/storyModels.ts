/**
 * Which model each kind of the room's work is asked of, as this machine has it.
 *
 * The deployment's defaults are what a room that has chosen nothing asks, so
 * only a reader's own choosing is kept here: the model the words are written
 * by, the one the pictures are drawn by, the one the shots are filmed by, the
 * one the lines are read aloud by, and the one the score is composed by. Which
 * model answers is about the person at the machine rather than about the
 * telling, so it is kept beside the project rather than inside it, and a
 * package handed to somebody else carries none of it.
 *
 * A place is not a capability: the room reads a telling in places — the one
 * its lines are read aloud in, the one its score is composed in — and each
 * place asks the capability that serves it, so a machine that keeps a
 * composer of its own says so by configuring a music model rather than here.
 */

import { create } from "zustand";

import type { StoryJobKind } from "../../../api/story";
import {
  currentUiPrefs,
  rememberUiPrefs,
} from "../../../shared/prefs/prefsData";

/** Where one kind of the room's work is asked. */
export type StoryAskPlace = "text" | "image" | "video" | "audio" | "music";

/** The places in the order the room reads them: words, then the picture, then
 * the sound that goes under both. */
export const STORY_ASK_PLACES: StoryAskPlace[] = [
  "text",
  "image",
  "video",
  "audio",
  "music",
];

/** Which batch is asked of which place. */
const PLACE_OF_KIND: Record<StoryJobKind, StoryAskPlace> = {
  outline: "text",
  elements: "text",
  storyboard: "text",
  elementArt: "image",
  keyframeArt: "image",
  actVideo: "video",
  keyframeVideo: "video",
  voice: "audio",
  music: "music",
};

/** The place a batch of work is asked of. */
export function askPlaceOfKind(kind: StoryJobKind): StoryAskPlace {
  return PLACE_OF_KIND[kind];
}

/** What the room is set to, by place. A place with nothing kept asks the
 * deployment's default. */
export type StoryModelChoices = Partial<Record<StoryAskPlace, string>>;

function read(): StoryModelChoices {
  const parsed = currentUiPrefs().storyModels;
  const choices: StoryModelChoices = {};
  for (const place of STORY_ASK_PLACES) {
    const reference: unknown = parsed[place];
    if (typeof reference === "string" && reference !== "") {
      choices[place] = reference;
    }
  }
  return choices;
}

function keep(place: StoryAskPlace, reference: string | null) {
  rememberUiPrefs({ storyModels: { [place]: reference } });
}

interface StoryModelsState {
  choices: StoryModelChoices;
  /** Sets the model one place is asked of, or clears it back to the default. */
  choose: (place: StoryAskPlace, reference: string | null) => void;
}

export const useStoryModels = create<StoryModelsState>()((set, get) => ({
  choices: read(),

  choose(place, reference) {
    const choices: StoryModelChoices = { ...get().choices };
    const kept = reference === "" ? null : reference;
    if (kept === null) delete choices[place];
    else choices[place] = kept;
    keep(place, kept);
    set({ choices });
  },
}));

/**
 * The model the room is set to ask for a kind of work, or none for the
 * deployment's default. Read where a batch is started rather than where it is
 * planned, so a batch asked for the moment the picker changed is asked of what
 * the picker says now.
 */
export function storyAskModel(kind: StoryJobKind): string | null {
  return useStoryModels.getState().choices[askPlaceOfKind(kind)] ?? null;
}

/**
 * The model the room's own words are written by.
 *
 * A rewrite of a clip's prompt is a text ask like the outline and the board,
 * so it is asked of the same model rather than of one chosen separately.
 */
export function storyTextModel(): string | null {
  return useStoryModels.getState().choices.text ?? null;
}
