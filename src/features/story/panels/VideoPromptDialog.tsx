import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { MAX_PROMPT_LENGTH } from "../../../shared/domain/constants";
import { fnv1a } from "../../../shared/domain/digest";
import { actAt, videoPromptOverride } from "../../../shared/domain/story";
import type {
  StoryDocument,
  StoryPromptOverride,
} from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import {
  actVideoModel,
  planActVideoWaves,
  planKeyframeVideoWaves,
} from "../jobs/plan";
import { videoPromptRewrite } from "../jobs/promptRewrite";
import { PromptIssues } from "./PromptIssues";
import { liveStory } from "./removeOldTake";
import {
  useVideoPromptSessions,
  type VideoPromptPlace,
} from "./videoPromptSessions";
import { useStoryWavesAsk } from "../stores/storyJobStore";
import { ModelPicker } from "../../settings/ModelPicker";

export type { VideoPromptPlace };

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
 *
 * In `film` mode the dialog stands in front of the press that would have
 * filmed the place: the words may be sent as they are, or rewritten for the
 * model first. A rewrite is one ask of a text model — the room's own unless
 * the reader names another here — and what it writes goes back into the field;
 * nothing is sent until the reader presses send over words they have seen.
 *
 * What the dialog holds lives beside it rather than inside it, by the place it
 * was opened on: closing the dialog puts the words aside without taking back a
 * rewrite they were sent on, and opening it again reads the same session —
 * including a rewrite still on its way.
 */
export function VideoPromptDialog({
  story,
  place,
  mode = "edit",
  onClose,
}: {
  story: StoryDocument;
  place: VideoPromptPlace;
  /** Whether the dialog was opened to film the place or only to edit its words. */
  mode?: "edit" | "film";
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const runArt = useStoryWavesAsk();
  const [key] = useState(() =>
    useVideoPromptSessions.getState().open(story, place),
  );
  const session = useVideoPromptSessions((state) => state.sessions[key]);
  const patch = useVideoPromptSessions((state) => state.patch);
  const drop = useVideoPromptSessions((state) => state.drop);
  const rewrite = useVideoPromptSessions((state) => state.rewrite);

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
    values,
    error,
    rewriting,
    rewriteModel,
    issues,
    rewriteError,
  } = session;
  const kind = place.kind === "act" ? "actVideo" : "keyframeVideo";
  // The guide is the one the words will be held to when they are sent, which
  // is the contract of the model that films the place rather than the step's.
  const act = actAt(live, place.chapterId, place.actId);
  const guide = videoPromptRewrite(
    kind,
    act === undefined ? null : actVideoModel(act),
  );

  const overrides = live.videoPromptOverrides ?? {};
  /** Keys written for the asks this place used to have, and no longer has. */
  const liveIds = new Set(shown.map((ask) => ask.id));
  const prefix =
    place.kind === "act"
      ? `actVideo:${place.chapterId}:${place.actId}`
      : `keyframeVideo:${place.chapterId}:${place.actId}:${place.keyframeId ?? ""}`;
  const orphans = Object.keys(overrides).filter(
    (askId) =>
      (askId === prefix || askId.startsWith(`${prefix}:`)) &&
      !liveIds.has(askId),
  );

  const autoPrompt = (askId: string, shownWords: string) =>
    auto[askId] ?? shownWords;

  const setValue = (at: number, next: string) => {
    patch(key, {
      values: values.map((value, index) => (index === at ? next : value)),
      error: null,
      // The checks belong to the words the model wrote; once the reader
      // changes them they are no longer about these.
      issues: [],
      rewriteError: null,
    });
  };

  const reset = (at: number) => {
    const ask = shown[at];
    if (ask === undefined) return;
    setValue(at, autoPrompt(ask.id, ask.prompt));
  };

  const save = (film: boolean) => {
    for (const value of values) {
      if (value.trim() === "") {
        patch(key, { error: t("story:storyboard.videoPromptEmpty") });
        return;
      }
    }
    const prompts: Record<string, StoryPromptOverride | null> = {};
    shown.forEach((ask, at) => {
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
      // The document as it stands after the write, not the telling this
      // dialog was opened from. The model the place is filmed by is read from
      // that document too, since an act may name one of its own.
      const fresh = liveStory(story.id) ?? story;
      void runArt(
        story.id,
        place.kind === "act" ? "actVideo" : "keyframeVideo",
        place.kind === "act"
          ? planActVideoWaves(fresh, place.chapterId, [place.actId])
          : planKeyframeVideoWaves(fresh, place.chapterId, place.actId, [
              place.keyframeId ?? "",
            ]),
      );
    }
    // The telling holds the words now, so the session has nothing left to
    // keep — and a rewrite still on its way is let go rather than written
    // over words that were just saved.
    drop(key);
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
        <p className="dialog-note">
          {mode === "film"
            ? t("story:storyboard.videoPromptFilmHint")
            : t("story:storyboard.videoPromptHint")}
        </p>

        {shown.length === 0 ? (
          <p className="story-hint">
            {t("story:storyboard.videoPromptNothing")}
          </p>
        ) : (
          shown.map((ask, at) => {
            const automatic = autoPrompt(ask.id, ask.prompt);
            const held = videoPromptOverride(live, ask.id);
            const moved = held !== undefined && held.auto !== fnv1a(automatic);
            return (
              <div className="story-video-prompt-piece" key={ask.id}>
                <span className="story-video-prompt-caption">
                  {shown.length > 1
                    ? t("story:storyboard.videoPromptPiece", {
                        index: at + 1,
                        total: shown.length,
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
                  onChange={(event) => setValue(at, event.target.value)}
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

        <PromptIssues issues={issues} testId="story-video-prompt-issues" />

        {rewriteError !== null && (
          <div
            className="story-video-prompt-error"
            data-testid="story-video-prompt-rewrite-error"
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

        {mode === "film" && guide !== null && (
          <div className="story-video-prompt-model">
            {/* Which text model does the rewriting: the room's own unless the
                reader names one for this place, and nothing else about the
                filming changes with it. */}
            <ModelPicker
              capability="text"
              disabled={rewriting}
              label={t("story:storyboard.videoPromptRewriteModel")}
              noneLabel={t("story:storyboard.modelGlobal")}
              onChange={(reference) => patch(key, { rewriteModel: reference })}
              testId="story-video-prompt-model"
              value={rewriteModel}
            />
          </div>
        )}

        <div className="dialog-actions">
          <button
            data-testid="story-video-prompt-cancel"
            onClick={onClose}
            type="button"
          >
            {t("story:panels.cancel")}
          </button>
          {mode === "film" ? (
            <>
              {guide !== null && (
                <button
                  data-testid="story-video-prompt-rewrite"
                  disabled={rewriting || shown.length === 0}
                  onClick={() => rewrite(key)}
                  type="button"
                >
                  {rewriting
                    ? t("story:storyboard.videoPromptRewriting")
                    : t("story:storyboard.videoPromptRewrite")}
                </button>
              )}
              <button
                className="primary"
                data-testid="story-video-prompt-send"
                disabled={rewriting || shown.length === 0}
                onClick={() => save(true)}
                type="button"
              >
                {t("story:storyboard.videoPromptSend")}
              </button>
            </>
          ) : (
            <>
              <button
                data-testid="story-video-prompt-save"
                disabled={shown.length === 0}
                onClick={() => save(false)}
                type="button"
              >
                {t("story:storyboard.videoPromptSave")}
              </button>
              <button
                className="primary"
                data-testid="story-video-prompt-film"
                disabled={shown.length === 0}
                onClick={() => save(true)}
                type="button"
              >
                {t("story:storyboard.videoPromptSaveAndFilm")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
