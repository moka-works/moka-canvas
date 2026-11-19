/**
 * What a picture's prompt dialog is holding, by the place it was opened on.
 *
 * The dialog is the only place the words a picture will be drawn with can be
 * read and changed, and the rewrite of them is one ask of a text model.
 * Neither belongs to the dialog being on screen: a reader who closes the
 * dialog has put the words aside, not taken back the ask, so the rewrite goes
 * on writing into the session and the dialog opened again on the same place
 * reads them from here. Taking the rewrite back is the cancel button's own
 * work, offered only while it is on its way.
 *
 * A session is dropped when its words are saved — the telling holds them then
 * — and when the board has moved so far that the ask it was written for is
 * not the place's ask any more. A board that moved under the same ask keeps
 * the session: words the reader wrote or a model rewrote stay, and the field
 * nobody touched takes the board's new words. Only a rewrite still on its way
 * is left whole, since its answer belongs to the words already shown.
 */

import { create } from "zustand";

import { errorText } from "../../../api/client";
import type { StoryJobItemDraft } from "../../../api/story";
import { withoutImagePromptOverrides } from "../../../shared/domain/story";
import type { StoryDocument } from "../../../shared/domain/types";
import type { ImagePromptContext } from "../../../shared/prompts/image/promptContext";
import type { PromptContractIssue } from "../../../shared/prompts/promptContract";
import {
  elementArtPromptContext,
  keyframeArtPromptContext,
} from "../jobs/imagePromptContext";
import {
  elementArtModel,
  keyframeArtModel,
  planElementArt,
  planKeyframeArt,
} from "../jobs/plan";
import { imagePromptRewrite, rewriteImagePrompt } from "../jobs/promptRewrite";
import type { PromptRewriteGuide } from "../jobs/promptRewrite";
import { liveStory } from "./removeOldTake";

/** The picture whose prompt is being edited. */
export type ImagePromptPlace =
  | {
      kind: "keyframe";
      chapterId: string;
      actId: string;
      keyframeId: string;
      /** What the row calls this shot, for the dialog's title. */
      name: string;
    }
  | {
      kind: "element";
      elementId: string;
      view: "main" | "turnaround";
      variantId?: string;
      /** What the card calls this picture, for the dialog's title. */
      name: string;
    };

function planned(
  story: StoryDocument,
  place: ImagePromptPlace,
): StoryJobItemDraft | undefined {
  return place.kind === "keyframe"
    ? planKeyframeArt(story, [
        {
          chapterId: place.chapterId,
          actId: place.actId,
          keyframeId: place.keyframeId,
        },
      ])[0]
    : planElementArt(story, [
        {
          elementId: place.elementId,
          view: place.view,
          ...(place.variantId === undefined
            ? {}
            : { variantId: place.variantId }),
        },
      ])[0];
}

/** The contract the model this place is drawn by declares, or none. */
export function imagePromptGuideFor(
  live: StoryDocument,
  place: ImagePromptPlace,
): PromptRewriteGuide | null {
  if (place.kind === "keyframe") {
    return imagePromptRewrite(
      "keyframeArt",
      keyframeArtModel(live, {
        chapterId: place.chapterId,
        actId: place.actId,
        keyframeId: place.keyframeId,
      }),
    );
  }
  const element = live.elements.find((held) => held.id === place.elementId);
  return imagePromptRewrite(
    "elementArt",
    element === undefined ? null : elementArtModel(element, place.variantId),
  );
}

/** The material the place's rewrite is told about, or none. */
export function imagePromptContextFor(
  live: StoryDocument,
  place: ImagePromptPlace,
): ImagePromptContext | null {
  return place.kind === "keyframe"
    ? keyframeArtPromptContext(
        live,
        place.chapterId,
        place.actId,
        place.keyframeId,
      )
    : elementArtPromptContext(
        live,
        place.elementId,
        place.view,
        place.variantId,
      );
}

/** The session one place's dialog reads and writes. */
export interface ImagePromptSession {
  storyId: string;
  place: ImagePromptPlace;
  /** The telling as it stood when these words were first shown. */
  live: StoryDocument;
  /** The ask this place is drawn in, as it was planned. */
  shown: StoryJobItemDraft | undefined;
  /** The board's own words for the ask, before the reader wrote over them. */
  auto: string;
  /** The words the field holds. */
  value: string;
  /** Why saving was refused, while the reader is looking at the refusal. */
  error: string | null;
  /** Whether a rewrite is on its way just now. */
  rewriting: boolean;
  /** The text model that rewrites for this place, or none for the room's own. */
  rewriteModel: string | null;
  /** What the model's own contract still finds wrong with what it wrote. */
  issues: PromptContractIssue[];
  /** Why a rewrite failed, with the model's own words under it. */
  rewriteError: { message: string; detail?: string } | null;
}

interface ImagePromptSessionsState {
  sessions: Record<string, ImagePromptSession>;
  /**
   * Opens the words of a place: the session already held, or a fresh one
   * planned from the telling as it stands. A session whose ask the board has
   * moved on from is let go rather than shown against a place it no longer
   * describes; one the board moved under keeps what the reader has in hand
   * and refreshes everything else.
   */
  open: (story: StoryDocument, place: ImagePromptPlace) => string;
  patch: (
    key: string,
    patch: Partial<
      Pick<
        ImagePromptSession,
        | "value"
        | "error"
        | "rewriting"
        | "rewriteModel"
        | "issues"
        | "rewriteError"
      >
    >,
  ) => void;
  /** Drops a place's words, letting go of a rewrite still on its way. */
  drop: (key: string) => void;
  /** Rewrites the place's words for the model that draws it. */
  rewrite: (key: string) => void;
  /**
   * Takes back a rewrite still on its way, keeping the session and the words
   * the field holds. A rewrite that has landed is not one to take back.
   */
  cancelRewrite: (key: string) => void;
  /** Lets go of everything, as a project or a telling does. */
  reset: () => void;
}

/** The rewrites still on their way, by session key. */
const rewrites = new Map<string, AbortController>();

function keyOf(storyId: string, place: ImagePromptPlace): string {
  return place.kind === "keyframe"
    ? `${storyId}:keyframe:${place.chapterId}:${place.actId}:${place.keyframeId}`
    : `${storyId}:element:${place.elementId}:${place.view}:${place.variantId ?? ""}`;
}

export const useImagePromptSessions = create<ImagePromptSessionsState>()(
  (set, get) => ({
    sessions: {},

    open(story, place) {
      const key = keyOf(story.id, place);
      const live = liveStory(story.id) ?? story;
      const shown = planned(live, place);
      const auto =
        planned(withoutImagePromptOverrides(live), place)?.prompt ?? "";
      const held = get().sessions[key];
      if (held !== undefined) {
        if (held.shown?.id !== shown?.id) {
          get().drop(key);
        } else if (held.rewriting) {
          // A rewrite is on its way over the words the reader saw; the board
          // moving under it is not a reason to pull them out of their hands.
          return key;
        } else if (auto === held.auto) {
          return key;
        } else {
          // The board moved under the words: a field nobody has touched takes
          // the new ones, and words the reader wrote or a model rewrote stay.
          set((state) => ({
            sessions: {
              ...state.sessions,
              [key]: {
                ...held,
                live,
                shown,
                auto,
                value: held.value === held.auto ? auto : held.value,
                error: null,
              },
            },
          }));
          return key;
        }
      }
      set((state) => ({
        sessions: {
          ...state.sessions,
          [key]: {
            storyId: story.id,
            place,
            live,
            shown,
            auto,
            value: shown?.prompt ?? "",
            error: null,
            rewriting: false,
            rewriteModel: null,
            issues: [],
            rewriteError: null,
          },
        },
      }));
      return key;
    },

    patch(key, patch) {
      const held = get().sessions[key];
      if (held === undefined) return;
      set((state) => ({
        sessions: { ...state.sessions, [key]: { ...held, ...patch } },
      }));
    },

    drop(key) {
      const controller = rewrites.get(key);
      if (controller !== undefined) {
        rewrites.delete(key);
        controller.abort();
      }
      set((state) => {
        const sessions = { ...state.sessions };
        delete sessions[key];
        return { sessions };
      });
    },

    rewrite(key) {
      const session = get().sessions[key];
      if (
        session === undefined ||
        session.rewriting ||
        session.shown === undefined
      ) {
        return;
      }
      const guide = imagePromptGuideFor(session.live, session.place);
      if (guide === null) return;
      const context = imagePromptContextFor(session.live, session.place);
      const controller = new AbortController();
      rewrites.set(key, controller);
      get().patch(key, { rewriting: true, rewriteError: null, issues: [] });
      void (async () => {
        const ours = () => rewrites.get(key) === controller;
        try {
          const rewritten = await rewriteImagePrompt({
            prompt: session.value,
            ...(context === null ? {} : { context }),
            guide,
            model: session.rewriteModel,
            signal: controller.signal,
          });
          // The session was let go while the answer was on its way — saved,
          // or replaced by a new one — and nothing here belongs to it now.
          if (!ours()) return;
          get().patch(key, {
            value: rewritten.prompt,
            issues: rewritten.issues,
          });
        } catch (problem) {
          if (!controller.signal.aborted && ours()) {
            get().patch(key, { rewriteError: errorText(problem) });
          }
        } finally {
          if (ours()) {
            rewrites.delete(key);
            get().patch(key, { rewriting: false });
          }
        }
      })();
    },

    cancelRewrite(key) {
      const controller = rewrites.get(key);
      if (controller === undefined) return;
      // The ask's own ending no longer belongs to this session, so the
      // rewriting is said to be over here rather than by the ask let go of.
      rewrites.delete(key);
      controller.abort();
      get().patch(key, { rewriting: false });
    },

    reset() {
      for (const controller of rewrites.values()) controller.abort();
      rewrites.clear();
      set({ sessions: {} });
    },
  }),
);
