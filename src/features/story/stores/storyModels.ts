/**
 * Which models each kind of the room's work is asked of, as this machine has it.
 *
 * The deployment's defaults are what a room that has chosen nothing asks, so
 * only a reader's own choosing is kept here: the models the words are written
 * by, the ones the pictures are drawn by, the ones the shots are filmed by, the
 * ones the lines are read aloud by, and the ones the score is composed by.
 * Which models answer is about the person at the machine rather than about the
 * telling, so it is kept beside the project rather than inside it, and a
 * package handed to somebody else carries none of it.
 *
 * A place keeps a list rather than one model: a reader who names several is
 * telling the room to spread the work over them, and the list is the order the
 * asks take turns in. A list of one is the choice the room used to keep, and a
 * place with no list asks the deployment's default.
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
  outlineRevision: "text",
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

/** What the room is set to, by place. A place with no list asks the
 * deployment's default. */
export type StoryModelChoices = Partial<Record<StoryAskPlace, string[]>>;

/** One place's list, as the machine kept it — a list now, a string before. */
function poolOf(raw: unknown): string[] {
  const references =
    typeof raw === "string"
      ? [raw]
      : Array.isArray(raw)
        ? raw.filter((held): held is string => typeof held === "string")
        : [];
  return [...new Set(references.filter((reference) => reference !== ""))];
}

function read(): StoryModelChoices {
  const parsed = currentUiPrefs().storyModels as Record<string, unknown>;
  const choices: StoryModelChoices = {};
  for (const place of STORY_ASK_PLACES) {
    const pool = poolOf(parsed[place]);
    if (pool.length > 0) choices[place] = pool;
  }
  return choices;
}

function keep(place: StoryAskPlace, references: string[] | null) {
  rememberUiPrefs({ storyModels: { [place]: references } });
}

interface StoryModelsState {
  choices: StoryModelChoices;
  /** Sets the models one place asks, in rotation order; none is the default. */
  choose: (place: StoryAskPlace, references: string[]) => void;
}

/**
 * How far each place's turn has got.
 *
 * Nothing here is remembered between visits: a turn is about where the room is
 * in its work, and work outlives a window. The turn is taken per request, not
 * per batch: ten drawings asked together are ten turns, which is what spreads
 * them over the models a reader named. Changing the list starts the turns over,
 * because the order that was being followed is no longer the one on screen.
 */
interface Turns {
  /** What the lists were when these turns began. */
  signature: string;
  cursors: Record<StoryAskPlace, number>;
}

/** Held apart from the lists so a change to them can start the turns over. */
const rotation: { turns: Turns | null } = { turns: null };

export const useStoryModels = create<StoryModelsState>()((set, get) => ({
  choices: read(),

  choose(place, references) {
    const choices: StoryModelChoices = { ...get().choices };
    const kept = poolOf(references);
    if (kept.length === 0) delete choices[place];
    else choices[place] = kept;
    keep(place, kept.length === 0 ? null : kept);
    rotation.turns = null;
    set({ choices });
  },
}));

// -----------------------------------------------------------------------------
// Taking turns
// -----------------------------------------------------------------------------

function signatureOf(choices: StoryModelChoices): string {
  return JSON.stringify(
    STORY_ASK_PLACES.map((place) => [place, choices[place] ?? []]),
  );
}

function turnsNow(): Turns {
  const { choices } = useStoryModels.getState();
  const signature = signatureOf(choices);
  if (rotation.turns === null || rotation.turns.signature !== signature) {
    rotation.turns = {
      signature,
      cursors: { text: 0, image: 0, video: 0, audio: 0, music: 0 },
    };
  }
  return rotation.turns;
}

/** The next model of one place's list, or none for the deployment's default. */
function nextModel(place: StoryAskPlace): string | null {
  const pool = useStoryModels.getState().choices[place] ?? [];
  if (pool.length === 0) return null;
  const held = turnsNow();
  const at = held.cursors[place] % pool.length;
  held.cursors[place] = at + 1;
  return pool[at] ?? null;
}

/** The list one place is set to, in rotation order. */
export function storyAskModels(kind: StoryJobKind): string[] {
  return useStoryModels.getState().choices[askPlaceOfKind(kind)] ?? [];
}

/** The model the list leads with, or none for the deployment's default. */
export function storyAskModelHead(kind: StoryJobKind): string | null {
  return storyAskModels(kind)[0] ?? null;
}

/**
 * The model one request of a kind takes its turn with, or none for the default.
 *
 * Read once per piece: a batch of ten drawings takes ten turns, and the pieces
 * that land on the same model are then asked together in one batch. A piece
 * whose target names a model of its own does not take a turn.
 */
export function storyAskModel(kind: StoryJobKind): string | null {
  return nextModel(askPlaceOfKind(kind));
}

/**
 * The model the room's own words are written by, taken in its turn.
 *
 * A rewrite of a clip's prompt is a text ask like the outline and the board,
 * so it takes a turn with the same list rather than standing aside from it.
 */
export function storyTextModel(): string | null {
  return nextModel("text");
}
