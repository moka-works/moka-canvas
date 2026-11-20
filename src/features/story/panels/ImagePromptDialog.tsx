import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import {
  MAX_IMAGES_PER_ASK,
  MAX_PROMPT_LENGTH,
} from "../../../shared/domain/constants";
import { fnv1a } from "../../../shared/domain/digest";
import { imagePromptOverride } from "../../../shared/domain/story";
import type {
  StoryDocument,
  StoryPromptOverride,
} from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { ModelPicker } from "../../settings/ModelPicker";
import { planElementArtWaves, planKeyframeArtWaves } from "../jobs/plan";
import { useStoryWavesAsk } from "../stores/storyJobStore";
import { PromptIssues } from "../../../shared/prompts/PromptIssues";
import {
  imagePromptGuideFor,
  useImagePromptSessions,
  type ImagePromptPlace,
} from "./imagePromptSessions";
import { liveStory } from "./removeOldTake";

export type { ImagePromptPlace };

function wavesFor(
  story: StoryDocument,
  place: ImagePromptPlace,
  count: number,
) {
  return place.kind === "keyframe"
    ? planKeyframeArtWaves(story, [
        {
          chapterId: place.chapterId,
          actId: place.actId,
          keyframeId: place.keyframeId,
          count,
        },
      ])
    : planElementArtWaves(story, [
        {
          elementId: place.elementId,
          view: place.view,
          count,
          ...(place.variantId === undefined
            ? {}
            : { variantId: place.variantId }),
        },
      ]);
}

/**
 * The words a picture is asked for, shown whole and open to the reader's hand.
 *
 * The board writes a picture's prompt from the frame or the element it belongs
 * to, and every word of it reaches the image model as it is. This dialog is
 * that whole text, so a detail the template cannot know can be said before the
 * ask is made. What is written here is kept with the telling and stands for
 * every ask that follows, until the reader hands the piece back to the board.
 *
 * When the model declares a prompt contract, the words can be rewritten for it
 * by a text model first; whatever comes back is put back into the field, and
 * nothing is drawn until the reader presses a button over words they have
 * seen.
 *
 * What the dialog holds lives beside it rather than inside it, by the place it
 * was opened on: closing the dialog puts the words aside without taking back a
 * rewrite they were sent on, and opening it again reads the same session —
 * including a rewrite still on its way. Taking that rewrite back is the cancel
 * button's own work, offered only while it is on its way; the corner's ✕ only
 * closes, as clicking outside does.
 */
export function ImagePromptDialog({
  story,
  place,
  onClose,
}: {
  story: StoryDocument;
  place: ImagePromptPlace;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const runArt = useStoryWavesAsk();
  const [key] = useState(() =>
    useImagePromptSessions.getState().open(story, place),
  );
  const session = useImagePromptSessions((state) => state.sessions[key]);
  const patch = useImagePromptSessions((state) => state.patch);
  const drop = useImagePromptSessions((state) => state.drop);
  const rewrite = useImagePromptSessions((state) => state.rewrite);
  const cancelRewrite = useImagePromptSessions((state) => state.cancelRewrite);
  // How many pictures one press draws: one model call makes one drawing, so a
  // set is drawn side by side and offered as a choice.
  const [count, setCount] = useState(1);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Only while the save that drops the session is closing the dialog.
  if (session === undefined) return null;
  const {
    live,
    shown,
    auto,
    value,
    error,
    rewriting,
    rewriteModel,
    issues,
    rewriteError,
  } = session;
  const kind = place.kind === "keyframe" ? "keyframeArt" : "elementArt";
  const guide = imagePromptGuideFor(live, place);
  const held =
    shown === undefined ? undefined : imagePromptOverride(live, shown.id);

  const setValue = (next: string) => {
    patch(key, {
      value: next,
      error: null,
      // The checks belong to the words the model wrote; once the reader
      // changes them they are no longer about these.
      issues: [],
      rewriteError: null,
    });
  };

  const save = (draw: boolean) => {
    if (shown === undefined) return;
    if (value.trim() === "") {
      patch(key, { error: t("story:storyboard.imagePromptEmpty") });
      return;
    }
    const prompts: Record<string, StoryPromptOverride | null> = {};
    const digest = fnv1a(auto);
    if (value === auto) {
      if (held !== undefined) prompts[shown.id] = null;
    } else if (
      held === undefined ||
      held.prompt !== value ||
      held.auto !== digest
    ) {
      prompts[shown.id] = { prompt: value, auto: digest };
    }
    if (Object.keys(prompts).length > 0) {
      const done = execute(i18n.t("story:history.imagePrompts"), [
        {
          type: "setStoryImagePromptOverrides",
          storyId: story.id,
          prompts,
        },
      ]);
      if (done === null) return;
    }
    if (draw) {
      // The document as it stands after the write, not the telling this
      // dialog was opened from.
      const fresh = liveStory(story.id) ?? story;
      void runArt(story.id, kind, wavesFor(fresh, place, count));
    }
    // The telling holds the words now, so the session has nothing left to
    // keep — and a rewrite still on its way is let go rather than written
    // over words that were just saved.
    drop(key);
    onClose();
  };

  if (shown === undefined) {
    return createPortal(
      <div
        className="dialog-backdrop"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        role="presentation"
      >
        <div
          aria-labelledby="story-image-prompt-title"
          aria-modal="true"
          className="dialog story-image-prompt"
          data-testid="story-image-prompt-dialog"
          role="dialog"
        >
          <header className="dialog-head">
            <h2 id="story-image-prompt-title">
              {t("story:storyboard.imagePromptTitle")} · {place.name}
            </h2>
            <button
              aria-label={t("story:panels.close")}
              className="dialog-close"
              data-testid="story-image-prompt-close"
              onClick={onClose}
              type="button"
            >
              ✕
            </button>
          </header>
          <p className="story-hint">
            {t("story:storyboard.imagePromptNothing")}
          </p>
          <div className="dialog-actions">
            <button onClick={onClose} type="button">
              {t("story:panels.close")}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  const moved = held !== undefined && held.auto !== fnv1a(auto);

  return createPortal(
    <div
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        aria-labelledby="story-image-prompt-title"
        aria-modal="true"
        className="dialog story-image-prompt"
        data-testid="story-image-prompt-dialog"
        role="dialog"
      >
        <header className="dialog-head">
          <h2 id="story-image-prompt-title">
            {t("story:storyboard.imagePromptTitle")} · {place.name}
          </h2>
          <button
            aria-label={t("story:panels.close")}
            className="dialog-close"
            data-testid="story-image-prompt-close"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </header>
        <p className="dialog-note">{t("story:storyboard.imagePromptHint")}</p>

        <textarea
          aria-label={t("story:storyboard.imagePromptTitle")}
          autoFocus
          className="story-video-prompt-text"
          data-testid="story-image-prompt-text"
          maxLength={MAX_PROMPT_LENGTH}
          onChange={(event) => setValue(event.target.value)}
          rows={10}
          value={value}
        />

        {held !== undefined && (
          <span className="story-video-prompt-foot">
            <button
              className="link"
              data-testid="story-image-prompt-reset"
              onClick={() => setValue(auto)}
              type="button"
            >
              {t("story:storyboard.imagePromptReset")}
            </button>
            <span className="story-hint">
              {t("story:storyboard.imagePromptEdited")}
            </span>
            {moved && (
              <span
                className="story-hint"
                data-testid="story-image-prompt-moved"
              >
                {t("story:storyboard.imagePromptMoved")}
              </span>
            )}
          </span>
        )}
        {error !== null && (
          <p className="story-video-prompt-error" role="alert">
            {error}
          </p>
        )}

        <PromptIssues issues={issues} testId="story-image-prompt-issues" />

        {rewriteError !== null && (
          <div
            className="story-video-prompt-error"
            data-testid="story-image-prompt-rewrite-error"
            role="alert"
          >
            <p>{rewriteError.message}</p>
            {rewriteError.detail !== undefined && (
              <details>
                <summary>{t("common:promptIssues.detail")}</summary>
                <pre>{rewriteError.detail}</pre>
              </details>
            )}
          </div>
        )}

        {/*
          The rewrite stands in a column of its own, with the model it is asked
          of beneath it: the picker governs the rewrite and nothing else, and
          the drawing stands apart from both.
        */}
        <div className="story-prompt-footer">
          {guide !== null && (
            <div className="story-prompt-rewrite">
              <button
                data-testid="story-image-prompt-rewrite"
                disabled={rewriting}
                onClick={() => rewrite(key)}
                type="button"
              >
                {rewriting
                  ? t("story:storyboard.imagePromptRewriting")
                  : t("story:storyboard.imagePromptRewrite")}
              </button>
              {/* Which text model does the rewriting: the room's own unless the
                  reader names one for this picture. */}
              <ModelPicker
                capability="text"
                disabled={rewriting}
                label={t("story:storyboard.imagePromptRewriteModel")}
                noneLabel={t("story:storyboard.modelGlobal")}
                onChange={(reference) =>
                  patch(key, { rewriteModel: reference })
                }
                testId="story-image-prompt-model"
                value={rewriteModel}
              />
            </div>
          )}
          <div className="dialog-actions">
            <label
              className="story-draw-count"
              title={t("story:storyboard.imagePromptCountHint")}
            >
              <span>{t("story:panels.drawCount")}</span>
              <select
                aria-label={t("story:panels.drawCountLabel")}
                data-testid="story-image-prompt-count"
                disabled={rewriting}
                onChange={(event) => setCount(Number(event.target.value))}
                value={count}
              >
                {Array.from(
                  { length: MAX_IMAGES_PER_ASK },
                  (_, at) => at + 1,
                ).map((each) => (
                  <option key={each} value={each}>
                    {t("story:panels.drawCountOption", { count: each })}
                  </option>
                ))}
              </select>
            </label>
            {/* Taking the rewrite back, not closing over it: the words the
                field holds stay, and the dialog is open to asking again. */}
            {rewriting && (
              <button
                data-testid="story-image-prompt-cancel"
                onClick={() => cancelRewrite(key)}
                type="button"
              >
                {t("story:panels.cancel")}
              </button>
            )}
            <button
              data-testid="story-image-prompt-save"
              disabled={rewriting}
              onClick={() => save(false)}
              type="button"
            >
              {t("story:storyboard.imagePromptSave")}
            </button>
            <button
              className="primary"
              data-testid="story-image-prompt-draw"
              disabled={rewriting}
              onClick={() => save(true)}
              type="button"
            >
              {t("story:storyboard.imagePromptSaveAndDraw")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
