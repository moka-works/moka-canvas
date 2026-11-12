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
/** A leaving the elements reading is standing in the way of. */
export type PendingLeave =
  { kind: "step"; step: StoryStep } | { kind: "story"; storyId: string | null };

interface StoryState {
  storyId: string | null;
  step: StoryStep;
  /** Which episode step four has open; null is the first of them. */
  openChapterId: string | null;
  /** The cards unfolded in steps three and four, by element or act id. */
  expanded: string[];
  /** Whether the question a new story is opened under is standing. */
  newStoryOpen: boolean;
  /**
   * The element the elements step is to bring into view, once it is standing.
   *
   * A picture looked at from the board is edited on the card it belongs to, and
   * the reader should land on that card rather than on the first page of the
   * cast. Read and cleared by the step itself.
   */
  focusElementId: string | null;
  /**
   * The element the elements step is to open at its voice form, once standing.
   *
   * A batch that fell to a missing voice or a missing recording is repaired on
   * the character cards, and the form those fields live in is folded away. The
   * card is told to open it rather than the reader being left on a closed card
   * to find the row themselves.
   */
  focusVoiceId: string | null;
  /**
   * Whether the elements step still has reading of its own left to send.
   *
   * The step owns the waves it has not handed over yet and the merge that
   * follows them; leaving the step throws them away. It is the step that knows
   * this, so it sets the flag here where the room's own leaving can see it.
   */
  elementsBusy: boolean;
  /** The leaving a question is standing over, if one is. */
  pendingLeave: PendingLeave | null;
  /** Takes up the place a project's stories leave open. */
  adopt: (moka: MokaFile | null) => void;
  select: (storyId: string | null) => void;
  goStep: (step: StoryStep) => void;
  /** Opens the elements step on one of its cards, or clears the place. */
  focusElement: (elementId: string | null) => void;
  /** Opens the elements step on one card of the cast, at its voice form. */
  focusVoice: (elementId: string | null) => void;
  /** Whether leaving the elements step now would drop work. */
  setElementsBusy: (busy: boolean) => void;
  /** Goes where the standing question asked, without asking again. */
  leaveNow: () => void;
  /** Stays where the reader was. */
  stay: () => void;
  openChapter: (chapterId: string | null) => void;
  toggleExpanded: (id: string) => void;
  setNewStoryOpen: (open: boolean) => void;
  /** Everything the room was holding, when the project is put down. */
  forget: () => void;
}

/**
 * Where each step of a telling was scrolled to, by story and step.
 *
 * Scrolling is a place on this machine like the step itself: a reader who
 * stepped away to another step — or another room — and came back is put where
 * they were reading, not at the top of work they had already walked through.
 * Held outside the store's own state because nothing drawn depends on it.
 */
const stepScrolls = new Map<string, number>();

/** How far a step was scrolled when it was last left, or its top. */
export function stepScrollAt(key: string): number {
  return stepScrolls.get(key) ?? 0;
}

/** Keeps a step's scroll where the reader last left it. */
export function rememberStepScroll(key: string, top: number): void {
  stepScrolls.set(key, top);
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

export const useStoryStore = create<StoryState>()((set, get) => {
  /**
   * The leaving itself, once nothing stands in its way.
   *
   * Kept apart from the asking so that a reader who has said yes goes where
   * they said — the second look is not a second question.
   */
  const goToStep = (step: StoryStep) => {
    set({
      step,
      pendingLeave: null,
      ...(step === "elements"
        ? {}
        : { focusElementId: null, focusVoiceId: null }),
    });
    rememberPlace(useProjectStore.getState().moka?.metadata.id ?? null, {
      storyId: get().storyId,
      step,
    });
  };

  const goToStory = (storyId: string | null) => {
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
      pendingLeave: null,
      focusElementId: null,
      focusVoiceId: null,
    });
    rememberPlace(moka?.metadata.id ?? null, { storyId, step });
  };

  return {
    storyId: null,
    step: "idea",
    openChapterId: null,
    expanded: [],
    newStoryOpen: false,
    elementsBusy: false,
    focusElementId: null,
    focusVoiceId: null,
    pendingLeave: null,

    adopt(moka) {
      const stories = moka?.stories ?? [];
      const projectId = moka?.metadata.id ?? null;
      const held = get();
      const remembered = projectId ? rememberedPlace(projectId) : undefined;
      const wanted = held.storyId ?? remembered?.storyId ?? null;
      const found = stories.find((story) => story.id === wanted) ?? null;
      const storyId = found ? found.id : (stories[0]?.id ?? null);
      const story =
        found ?? stories.find((each) => each.id === storyId) ?? null;
      // A story that is no longer in the document — deleted here, or by an undo
      // — is not what the room can be looking at; the step, though, is where the
      // reader left it until the story it belonged to says otherwise.
      const step =
        held.storyId === storyId
          ? held.step
          : placeFor(story, remembered?.step);
      const openChapterId =
        story?.chapters.some((chapter) => chapter.id === held.openChapterId) ===
        true
          ? held.openChapterId
          : null;
      set({
        storyId,
        step,
        openChapterId,
        ...(held.storyId === storyId
          ? {}
          : { focusElementId: null, focusVoiceId: null }),
      });
      rememberPlace(projectId, { storyId, step });
    },

    select(storyId) {
      const held = get();
      if (storyId === held.storyId) {
        set({ pendingLeave: null });
        return;
      }
      if (held.step === "elements" && held.elementsBusy) {
        if (held.pendingLeave === null) {
          set({ pendingLeave: { kind: "story", storyId } });
        }
        return;
      }
      goToStory(storyId);
    },

    goStep(step) {
      const held = get();
      if (step === held.step) return;
      if (held.step === "elements" && held.elementsBusy) {
        if (held.pendingLeave === null) {
          set({ pendingLeave: { kind: "step", step } });
        }
        return;
      }
      goToStep(step);
    },

    focusElement(elementId) {
      // Going to the elements step is not leaving it: only what the step is
      // holding back from a departure stands in the way of one, and this is
      // the opposite direction.
      if (get().step !== "elements") goToStep("elements");
      set({ focusElementId: elementId, focusVoiceId: null });
    },

    focusVoice(elementId) {
      // A voice is written on a card, so the jump is the card's as well: the
      // element step is turned to the same way, and the card is told to open
      // the form the fields stand in.
      if (elementId === null) {
        set({ focusVoiceId: null });
        return;
      }
      if (get().step !== "elements") goToStep("elements");
      set({ focusElementId: elementId, focusVoiceId: elementId });
    },

    setElementsBusy(busy) {
      if (get().elementsBusy === busy) return;
      set({ elementsBusy: busy });
    },

    leaveNow() {
      const pending = get().pendingLeave;
      if (pending === null) return;
      if (pending.kind === "step") goToStep(pending.step);
      else goToStory(pending.storyId);
    },

    stay() {
      set({ pendingLeave: null });
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
      stepScrolls.clear();
      set({
        storyId: null,
        step: "idea",
        openChapterId: null,
        expanded: [],
        newStoryOpen: false,
        elementsBusy: false,
        focusElementId: null,
        focusVoiceId: null,
        pendingLeave: null,
      });
    },
  };
});

/**
 * The story the room is open on, or null when it is open on none.
 *
 * Read by its own identity rather than the project's: a save that moves the
 * revision, or a file filed on the shelf, leaves the story object as it was,
 * and a step that follows only its own telling is not drawn again for them.
 */
export function useActiveStory(): StoryDocument | null {
  const id = useStoryStore((state) => state.storyId);
  return useProjectStore((state) =>
    id === null
      ? null
      : ((state.moka?.stories ?? []).find((story) => story.id === id) ?? null),
  );
}
