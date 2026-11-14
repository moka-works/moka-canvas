/**
 * What a place's clip-prompt dialog is holding, by the place it was opened on.
 *
 * The dialog is the only place the words a clip will be filmed with can be
 * read and changed, and the rewrite of them is one ask of the room's text
 * model — sometimes several, one per part of a long act. Neither belongs to
 * the dialog being on screen: a reader who closes the dialog has put the words
 * aside, not taken back the ask, so the rewrite goes on writing into the
 * session and the dialog opened again on the same place reads them from here.
 *
 * A session is dropped when its words are saved — the telling holds them then
 * — and when the board has moved so far that the asks it was written for are
 * not the place's asks any more.
 */

import { create } from "zustand";

import { errorText } from "../../../api/client";
import type { StoryJobItemDraft } from "../../../api/story";
import { withoutVideoPromptOverrides } from "../../../shared/domain/story";
import type { StoryDocument } from "../../../shared/domain/types";
import { planActVideos, planKeyframeVideos } from "../jobs/plan";
import type { PromptContractIssue } from "../jobs/promptContract";
import { rewriteVideoPrompt, videoPromptRewrite } from "../jobs/promptRewrite";
import { liveStory } from "../panels/removeOldTake";

/** The place whose clip prompts are being edited. */
export interface VideoPromptPlace {
  /** An act filmed whole, a bridge, or one shot filmed on its own. */
  kind: "act" | "shot";
  chapterId: string;
  actId: string;
  /** The shot, where the place is one. */
  keyframeId?: string;
  /** What the card calls this place, for the dialog's title. */
  name: string;
}

function planFor(story: StoryDocument, place: VideoPromptPlace) {
  return place.kind === "act"
    ? planActVideos(story, place.chapterId, [place.actId])
    : planKeyframeVideos(story, place.chapterId, place.actId, [
        place.keyframeId ?? "",
      ]);
}

/** The session one place's dialog reads and writes. */
export interface VideoPromptSession {
  storyId: string;
  place: VideoPromptPlace;
  /** The telling as it stood when these words were first shown. */
  live: StoryDocument;
  /** The asks this place is filmed in, as they were planned. */
  shown: StoryJobItemDraft[];
  /** Each ask's own words, by ask id, before the reader wrote over any. */
  auto: Record<string, string>;
  /** The words the fields hold, one per ask. */
  values: string[];
  /** Why saving was refused, while the reader is looking at the refusal. */
  error: string | null;
  /** Whether a rewrite is on its way just now. */
  rewriting: boolean;
  /** What the model's own contract still finds wrong with what it wrote. */
  issues: PromptContractIssue[];
  /** Why a rewrite failed, with the model's own words under it. */
  rewriteError: { message: string; detail?: string } | null;
}

interface VideoPromptSessionsState {
  sessions: Record<string, VideoPromptSession>;
  /**
   * Opens the words of a place: the session already held, or a fresh one
   * planned from the telling as it stands. A session whose asks the board has
   * moved on from is let go rather than shown against a place it no longer
   * describes.
   */
  open: (story: StoryDocument, place: VideoPromptPlace) => string;
  patch: (
    key: string,
    patch: Partial<
      Pick<
        VideoPromptSession,
        "values" | "error" | "rewriting" | "issues" | "rewriteError"
      >
    >,
  ) => void;
  /** Drops a place's words, letting go of a rewrite still on its way. */
  drop: (key: string) => void;
  /** Rewrites every ask of the place for its model, one after another. */
  rewrite: (key: string) => void;
  /** Lets go of everything, as a project or a telling does. */
  reset: () => void;
}

/** The rewrites still on their way, by session key. */
const rewrites = new Map<string, AbortController>();

function keyOf(storyId: string, place: VideoPromptPlace): string {
  return `${storyId}:${place.kind}:${place.chapterId}:${place.actId}:${place.keyframeId ?? ""}`;
}

export const useVideoPromptSessions = create<VideoPromptSessionsState>()(
  (set, get) => ({
    sessions: {},

    open(story, place) {
      const key = keyOf(story.id, place);
      const live = liveStory(story.id) ?? story;
      const shown = planFor(live, place);
      const held = get().sessions[key];
      if (held !== undefined) {
        const same =
          held.shown.length === shown.length &&
          held.shown.every((ask, at) => ask.id === shown[at]?.id);
        if (same) return key;
        get().drop(key);
      }
      const auto = planFor(withoutVideoPromptOverrides(live), place);
      set((state) => ({
        sessions: {
          ...state.sessions,
          [key]: {
            storyId: story.id,
            place,
            live,
            shown,
            auto: Object.fromEntries(auto.map((ask) => [ask.id, ask.prompt])),
            values: shown.map((ask) => ask.prompt),
            error: null,
            rewriting: false,
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
      if (session === undefined || session.rewriting) return;
      const guide = videoPromptRewrite(
        session.place.kind === "act" ? "actVideo" : "keyframeVideo",
      );
      if (guide === null) return;
      const controller = new AbortController();
      rewrites.set(key, controller);
      get().patch(key, { rewriting: true, rewriteError: null, issues: [] });
      const next = [...session.values];
      const found: PromptContractIssue[] = [];
      // Written piece by piece rather than at the end: a long act is several
      // asks, and a reader who comes back midway should find the parts that
      // are already rewritten rather than the words they left.
      void (async () => {
        const ours = () => rewrites.get(key) === controller;
        try {
          for (const [at, ask] of session.shown.entries()) {
            const rewritten = await rewriteVideoPrompt({
              prompt: session.values[at] ?? "",
              ...(ask.promptContext === undefined
                ? {}
                : { context: ask.promptContext }),
              guide,
              signal: controller.signal,
            });
            next[at] = rewritten.prompt;
            found.push(...rewritten.issues);
            // The session was let go while this piece was on its way — saved,
            // or replaced by a new one — and nothing here belongs to it now.
            if (!ours()) return;
            get().patch(key, { values: [...next], issues: [...found] });
          }
        } catch (problem) {
          if (!controller.signal.aborted && ours()) {
            get().patch(key, {
              values: [...next],
              issues: [...found],
              rewriteError: errorText(problem),
            });
          }
        } finally {
          if (ours()) {
            rewrites.delete(key);
            get().patch(key, { rewriting: false });
          }
        }
      })();
    },

    reset() {
      for (const controller of rewrites.values()) controller.abort();
      rewrites.clear();
      set({ sessions: {} });
    },
  }),
);
