import { create } from "zustand";
import type { MokaFile, StoryDocument } from "../../../shared/domain";
import {
  STORY_STEPS,
  stepReachable,
  storyCurrentStep,
  storyProgress,
  type StoryStep,
} from "../../../shared/domain";
import { useProjectStore } from "../../editor/stores/projectStore";
import {
  currentUiPrefs,
  rememberUiPrefs,
} from "../../../shared/prefs/prefsData";

/**
 * Where a reader is standing in a story: which one is open and which step of
 * it, and which of its cards are unfolded.
 *
 * None of this is the document's business. Which story is being looked at is a
 * place on this machine, remembered beside the other choices about how the app
 * is used, and everything that changes the telling itself goes through the
 * command pipeline instead.
 */
interface StoryState {
  storyId: string | null;
  step: StoryStep;
  /** Which episode step four has open; null is the first of them. */
  openChapterId: string | null;
  /** The cards unfolded in steps three and four, by element or act id. */
  expanded: string[];
  /** Whether the question a new story is opened under is standing. */
  newStoryOpen: boolean;
  /** Takes up the place a project's stories leave open. */
  adopt: (moka: MokaFile | null) => void;
  select: (storyId: string | null) => void;
  goStep: (step: StoryStep) => void;
  openChapter: (chapterId: string | null) => void;
  toggleExpanded: (id: string) => void;
  setNewStoryOpen: (open: boolean) => void;
  /** Everything the room was holding, when the project is put down. */
  forget: () => void;
}

/** The place this machine remembers for a project, which may be nowhere. */
export function rememberedPlace(projectId: string):
  | {
      storyId: string | null;
      /** Absent when what was kept is not one of the five steps. */
      step?: StoryStep;
    }
  | undefined {
  const kept: unknown = currentUiPrefs().storyPlaces[projectId];
  if (typeof kept !== "object" || kept === null) return undefined;
  const record = kept as Record<string, unknown>;
  const step = STORY_STEPS.find((each) => each === record.step);
  return {
    storyId: typeof record.storyId === "string" ? record.storyId : null,
    ...(step ? { step } : {}),
  };
}

function rememberPlace(
  projectId: string | null,
  place: { storyId: string | null; step: StoryStep },
): void {
  if (projectId === null) return;
  rememberUiPrefs({
    storyPlaces: {
      [projectId]: { storyId: place.storyId, step: place.step },
    },
  });
}

/**
 * Where a reader stepping into the room is put: the step they were standing
 * on, as long as the story can still be stood on it, and otherwise the work
 * that is wanted next rather than the first thing that was ever done.
 *
 * A step the story has outgrown is not a door to stand in front of — a board
 * that was undone takes the reader back to the outline it was written from.
 */
function placeFor(
  story: StoryDocument | null,
  remembered: StoryStep | undefined,
): StoryStep {
  if (!story) return "idea";
  const progress = storyProgress(story);
  if (remembered !== undefined && stepReachable(progress, remembered)) {
    return remembered;
  }
  return storyCurrentStep(progress).step;
}

export const useStoryStore = create<StoryState>()((set, get) => ({
  storyId: null,
  step: "idea",
  openChapterId: null,
  expanded: [],
  newStoryOpen: false,

  adopt(moka) {
    const stories = moka?.stories ?? [];
    const projectId = moka?.metadata.id ?? null;
    const held = get();
    const remembered = projectId ? rememberedPlace(projectId) : undefined;
    const wanted = held.storyId ?? remembered?.storyId ?? null;
    const found = stories.find((story) => story.id === wanted) ?? null;
    const storyId = found ? found.id : (stories[0]?.id ?? null);
    const story = found ?? stories.find((each) => each.id === storyId) ?? null;
    // A story that is no longer in the document — deleted here, or by an undo
    // — is not what the room can be looking at; the step, though, is where the
    // reader left it until the story it belonged to says otherwise.
    const step =
      held.storyId === storyId ? held.step : placeFor(story, remembered?.step);
    const openChapterId =
      story?.chapters.some((chapter) => chapter.id === held.openChapterId) ===
      true
        ? held.openChapterId
        : null;
    set({ storyId, step, openChapterId });
    rememberPlace(projectId, { storyId, step });
  },

  select(storyId) {
    const moka = useProjectStore.getState().moka;
    const story =
      (moka?.stories ?? []).find((each) => each.id === storyId) ?? null;
    // A story just chosen is opened where its work stands, not where some
    // other story's reader left off.
    const step = placeFor(story, undefined);
    set({
      storyId,
      step,
      openChapterId: story?.chapters[0]?.id ?? null,
      expanded: [],
    });
    rememberPlace(moka?.metadata.id ?? null, { storyId, step });
  },

  goStep(step) {
    set({ step });
    rememberPlace(useProjectStore.getState().moka?.metadata.id ?? null, {
      storyId: get().storyId,
      step,
    });
  },

  openChapter(chapterId) {
    set({ openChapterId: chapterId });
  },

  toggleExpanded(id) {
    const expanded = get().expanded;
    set({
      expanded: expanded.includes(id)
        ? expanded.filter((each) => each !== id)
        : [...expanded, id],
    });
  },

  setNewStoryOpen(newStoryOpen) {
    set({ newStoryOpen });
  },

  forget() {
    set({
      storyId: null,
      step: "idea",
      openChapterId: null,
      expanded: [],
      newStoryOpen: false,
    });
  },
}));

/** The story the room is open on, or null when it is open on none. */
export function useActiveStory(): StoryDocument | null {
  const id = useStoryStore((state) => state.storyId);
  const moka = useProjectStore((state) => state.moka);
  if (id === null) return null;
  return (moka?.stories ?? []).find((story) => story.id === id) ?? null;
}
