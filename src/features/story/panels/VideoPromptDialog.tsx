import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { MAX_PROMPT_LENGTH } from "../../../shared/domain/constants";
import { fnv1a } from "../../../shared/domain/digest";
import {
  withoutVideoPromptOverrides,
  videoPromptOverride,
} from "../../../shared/domain/story";
import type {
  StoryDocument,
  StoryVideoPromptOverride,
} from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { planActVideos, planKeyframeVideos } from "../jobs/plan";
import { liveStory } from "./removeOldTake";
import { useStoryRun } from "../stores/storyJobStore";

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

/** How many seconds a planned ask is for, as its parameters carry it. */
function secondsOf(params: Record<string, unknown> | undefined): number {
  const seconds = Number(params?.seconds);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
}

/**
 * The words a clip is asked for, shown whole and open to the reader's hand.
 *
 * The board writes a clip's prompt from what stands around it, and every word
 * of it reaches the model as it is. This dialog is that whole text, one piece
 * per ask an act may be filmed in, so a detail the template cannot know — how
 * a light falls, what a camera leaves out — can be said before the ask is
 * made. What is written here is kept with the telling and stands for every ask
 * that follows, until the reader hands the piece back to the board.
 */
export function VideoPromptDialog({
  story,
  place,
  onClose,
}: {
  story: StoryDocument;
  place: VideoPromptPlace;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const run = useStoryRun();
  // The telling as it stands at the moment the dialog opens: what the asks are
  // planned from, and the words the reader has already written.
  const [opened] = useState(() => {
    const live = liveStory(story.id) ?? story;
    const auto = planFor(withoutVideoPromptOverrides(live), place);
    const shown = planFor(live, place);
    return { live, auto: new Map(auto.map((ask) => [ask.id, ask])), shown };
  });
  const [values, setValues] = useState(() =>
    opened.shown.map((ask) => ask.prompt),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const overrides = opened.live.videoPromptOverrides ?? {};
  /** Keys written for the asks this place used to have, and no longer has. */
  const liveIds = new Set(opened.shown.map((ask) => ask.id));
  const prefix =
    place.kind === "act"
      ? `actVideo:${place.chapterId}:${place.actId}`
      : `keyframeVideo:${place.chapterId}:${place.actId}:${place.keyframeId ?? ""}`;
  const orphans = Object.keys(overrides).filter(
    (askId) =>
      (askId === prefix || askId.startsWith(`${prefix}:`)) &&
      !liveIds.has(askId),
  );

  const autoPrompt = (askId: string, shown: string) =>
    opened.auto.get(askId)?.prompt ?? shown;

  const reset = (at: number) => {
    const ask = opened.shown[at];
    if (ask === undefined) return;
    const auto = autoPrompt(ask.id, ask.prompt);
    setValues((held) =>
      held.map((value, index) => (index === at ? auto : value)),
    );
    setError(null);
  };

  const save = (film: boolean) => {
    for (const value of values) {
      if (value.trim() === "") {
        setError(t("story:storyboard.videoPromptEmpty"));
        return;
      }
    }
    const prompts: Record<string, StoryVideoPromptOverride | null> = {};
    opened.shown.forEach((ask, at) => {
      const text = values[at] ?? "";
      const auto = autoPrompt(ask.id, ask.prompt);
      const held = overrides[ask.id];
      if (text === auto) {
        if (held !== undefined) prompts[ask.id] = null;
        return;
      }
      const digest = fnv1a(auto);
      // Words the reader has not touched keep the reading of the board they
      // were written against, so a board that moved on stays visible as such.
      if (held !== undefined && held.prompt === text && held.auto === digest)
        return;
      prompts[ask.id] = { prompt: text, auto: digest };
    });
    for (const askId of orphans) prompts[askId] = null;
    if (Object.keys(prompts).length > 0) {
      execute(i18n.t("story:history.videoPrompts"), [
        {
          type: "setStoryVideoPromptOverrides",
          storyId: story.id,
          prompts,
        },
      ]);
    }
    if (film) {
      // The document as it stands after the write, not the render this dialog
      // was opened from.
      const live = liveStory(story.id) ?? story;
      const items = planFor(live, place);
      void run(
        story.id,
        place.kind === "act" ? "actVideo" : "keyframeVideo",
        items,
      );
    }
    onClose();
  };

  return createPortal(
    <div
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        aria-labelledby="story-video-prompt-title"
        aria-modal="true"
        className="dialog story-video-prompt"
        data-testid="story-video-prompt-dialog"
        role="dialog"
      >
        <h2 id="story-video-prompt-title">
          {t("story:storyboard.videoPromptTitle")} · {place.name}
        </h2>
        <p className="dialog-note">{t("story:storyboard.videoPromptHint")}</p>

        {opened.shown.length === 0 ? (
          <p className="story-hint">
            {t("story:storyboard.videoPromptNothing")}
          </p>
        ) : (
          opened.shown.map((ask, at) => {
            const auto = autoPrompt(ask.id, ask.prompt);
            const held = videoPromptOverride(opened.live, ask.id);
            const moved = held !== undefined && held.auto !== fnv1a(auto);
            return (
              <div className="story-video-prompt-piece" key={ask.id}>
                <span className="story-video-prompt-caption">
                  {opened.shown.length > 1
                    ? t("story:storyboard.videoPromptPiece", {
                        index: at + 1,
                        total: opened.shown.length,
                        seconds: secondsOf(ask.params),
                      })
                    : t("story:storyboard.videoPromptSeconds", {
                        seconds: secondsOf(ask.params),
                      })}
                </span>
                <textarea
                  aria-label={t("story:storyboard.videoPromptTitle")}
                  autoFocus={at === 0}
                  className="story-video-prompt-text"
                  data-testid={`story-video-prompt-text-${at}`}
                  maxLength={MAX_PROMPT_LENGTH}
                  onChange={(event) => {
                    const next = event.target.value;
                    setValues((heldValues) =>
                      heldValues.map((value, index) =>
                        index === at ? next : value,
                      ),
                    );
                    setError(null);
                  }}
                  rows={8}
                  value={values[at] ?? ""}
                />
                {held !== undefined && (
                  <span className="story-video-prompt-foot">
                    <button
                      className="link"
                      data-testid={`story-video-prompt-reset-${at}`}
                      onClick={() => reset(at)}
                      type="button"
                    >
                      {t("story:storyboard.videoPromptReset")}
                    </button>
                    <span className="story-hint">
                      {t("story:storyboard.videoPromptEdited")}
                    </span>
                    {moved && (
                      <span
                        className="story-hint"
                        data-testid={`story-video-prompt-moved-${at}`}
                      >
                        {t("story:storyboard.videoPromptMoved")}
                      </span>
                    )}
                  </span>
                )}
              </div>
            );
          })
        )}

        {orphans.length > 0 && (
          <p className="story-hint">
            {t("story:storyboard.videoPromptOrphans", {
              count: orphans.length,
            })}
          </p>
        )}
        {error !== null && (
          <p className="story-video-prompt-error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button
            data-testid="story-video-prompt-cancel"
            onClick={onClose}
            type="button"
          >
            {t("story:panels.cancel")}
          </button>
          <button
            data-testid="story-video-prompt-save"
            disabled={opened.shown.length === 0}
            onClick={() => save(false)}
            type="button"
          >
            {t("story:storyboard.videoPromptSave")}
          </button>
          <button
            className="primary"
            data-testid="story-video-prompt-film"
            disabled={opened.shown.length === 0}
            onClick={() => save(true)}
            type="button"
          >
            {t("story:storyboard.videoPromptSaveAndFilm")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
