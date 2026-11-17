import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { errorText } from "../../../api/client";
import { MAX_PROMPT_LENGTH } from "../../../shared/domain/constants";
import { fnv1a } from "../../../shared/domain/digest";
import {
  imagePromptOverride,
  withoutImagePromptOverrides,
} from "../../../shared/domain/story";
import type {
  StoryDocument,
  StoryPromptOverride,
} from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import type { PromptContractIssue } from "../../../shared/prompts/promptContract";
import { execute } from "../../editor/commands/execute";
import { ModelPicker } from "../../settings/ModelPicker";
import {
  elementArtPromptContext,
  keyframeArtPromptContext,
} from "../jobs/imagePromptContext";
import {
  elementArtModel,
  keyframeArtModel,
  planElementArt,
  planElementArtWaves,
  planKeyframeArt,
  planKeyframeArtWaves,
} from "../jobs/plan";
import { imagePromptRewrite, rewriteImagePrompt } from "../jobs/promptRewrite";
import { useStoryWavesAsk } from "../stores/storyJobStore";
import { PromptIssues } from "../../../shared/prompts/PromptIssues";
import { liveStory } from "./removeOldTake";

/** The picture whose prompt is being read and changed. */
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

function planned(story: StoryDocument, place: ImagePromptPlace) {
  return place.kind === "keyframe"
    ? planKeyframeArt(story, [
        {
          chapterId: place.chapterId,
          actId: place.actId,
          keyframeId: place.keyframeId,
        },
      ])
    : planElementArt(story, [
        {
          elementId: place.elementId,
          view: place.view,
          ...(place.variantId === undefined
            ? {}
            : { variantId: place.variantId }),
        },
      ]);
}

function wavesFor(story: StoryDocument, place: ImagePromptPlace) {
  return place.kind === "keyframe"
    ? planKeyframeArtWaves(story, [
        {
          chapterId: place.chapterId,
          actId: place.actId,
          keyframeId: place.keyframeId,
        },
      ])
    : planElementArtWaves(story, [
        {
          elementId: place.elementId,
          view: place.view,
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
 * by the room's text model first; whatever comes back is put back into the
 * field, and nothing is drawn until the reader presses a button over words
 * they have seen.
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
  const live = liveStory(story.id) ?? story;
  const shown = planned(live, place)[0];
  const auto =
    planned(withoutImagePromptOverrides(live), place)[0]?.prompt ?? "";
  const held =
    shown === undefined ? undefined : imagePromptOverride(live, shown.id);
  const [value, setValue] = useState(() => shown?.prompt ?? "");
  const [error, setError] = useState<string | null>(null);
  const [rewriting, setRewriting] = useState(false);
  const [rewriteModel, setRewriteModel] = useState<string | null>(null);
  const [issues, setIssues] = useState<PromptContractIssue[]>([]);
  const [rewriteError, setRewriteError] = useState<{
    message: string;
    detail?: string;
  } | null>(null);
  const rewriteController = useRef<AbortController | null>(null);

  const kind = place.kind === "keyframe" ? "keyframeArt" : "elementArt";
  const element =
    place.kind === "element"
      ? live.elements.find((heldElement) => heldElement.id === place.elementId)
      : undefined;
  const model =
    place.kind === "keyframe"
      ? keyframeArtModel(live, {
          chapterId: place.chapterId,
          actId: place.actId,
          keyframeId: place.keyframeId,
        })
      : element === undefined
        ? null
        : elementArtModel(element, place.variantId);
  const guide = imagePromptRewrite(kind, model);
  const context =
    place.kind === "keyframe"
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      rewriteController.current?.abort();
    };
  }, [onClose]);

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
          <h2 id="story-image-prompt-title">
            {t("story:storyboard.imagePromptTitle")} · {place.name}
          </h2>
          <p className="story-hint">
            {t("story:storyboard.imagePromptNothing")}
          </p>
          <div className="dialog-actions">
            <button
              data-testid="story-image-prompt-cancel"
              onClick={onClose}
              type="button"
            >
              {t("story:panels.cancel")}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  const moved = held !== undefined && held.auto !== fnv1a(auto);

  const rewrite = () => {
    if (guide === null || rewriting) return;
    const controller = new AbortController();
    rewriteController.current = controller;
    setRewriting(true);
    setRewriteError(null);
    setIssues([]);
    void (async () => {
      try {
        const rewritten = await rewriteImagePrompt({
          prompt: value,
          ...(context === null ? {} : { context }),
          guide,
          model: rewriteModel,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setValue(rewritten.prompt);
          setIssues(rewritten.issues);
        }
      } catch (problem) {
        if (!controller.signal.aborted) setRewriteError(errorText(problem));
      } finally {
        if (!controller.signal.aborted) {
          rewriteController.current = null;
          setRewriting(false);
        }
      }
    })();
  };

  const save = (draw: boolean) => {
    if (value.trim() === "") {
      setError(t("story:storyboard.imagePromptEmpty"));
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
      void runArt(story.id, kind, wavesFor(fresh, place));
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
        aria-labelledby="story-image-prompt-title"
        aria-modal="true"
        className="dialog story-image-prompt"
        data-testid="story-image-prompt-dialog"
        role="dialog"
      >
        <h2 id="story-image-prompt-title">
          {t("story:storyboard.imagePromptTitle")} · {place.name}
        </h2>
        <p className="dialog-note">{t("story:storyboard.imagePromptHint")}</p>

        <textarea
          aria-label={t("story:storyboard.imagePromptTitle")}
          autoFocus
          className="story-video-prompt-text"
          data-testid="story-image-prompt-text"
          maxLength={MAX_PROMPT_LENGTH}
          onChange={(event) => {
            setValue(event.target.value);
            setIssues([]);
            setError(null);
            setRewriteError(null);
          }}
          rows={10}
          value={value}
        />

        {held !== undefined && (
          <span className="story-video-prompt-foot">
            <button
              className="link"
              data-testid="story-image-prompt-reset"
              onClick={() => {
                setValue(auto);
                setIssues([]);
                setError(null);
              }}
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

        {guide !== null && (
          <div className="story-video-prompt-model">
            {/* Which text model does the rewriting: the room's own unless the
                reader names one for this picture. */}
            <ModelPicker
              capability="text"
              disabled={rewriting}
              label={t("story:storyboard.imagePromptRewriteModel")}
              noneLabel={t("story:storyboard.modelGlobal")}
              onChange={setRewriteModel}
              testId="story-image-prompt-model"
              value={rewriteModel}
            />
          </div>
        )}

        <div className="dialog-actions">
          <button
            data-testid="story-image-prompt-cancel"
            onClick={onClose}
            type="button"
          >
            {t("story:panels.cancel")}
          </button>
          {guide !== null ? (
            <button
              data-testid="story-image-prompt-rewrite"
              disabled={rewriting}
              onClick={rewrite}
              type="button"
            >
              {rewriting
                ? t("story:storyboard.imagePromptRewriting")
                : t("story:storyboard.imagePromptRewrite")}
            </button>
          ) : null}
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
    </div>,
    document.body,
  );
}
