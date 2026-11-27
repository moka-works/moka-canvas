import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import {
  MAX_PROMPT_LENGTH,
  MAX_VIDEO_TAKES_PER_ASK,
} from "../../../shared/domain/constants";
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
import {
  actVideoVoiceReference,
  voiceReferenceState,
} from "../jobs/voiceReferences";
import { PromptIssues } from "../../../shared/prompts/PromptIssues";
import { liveStory } from "./removeOldTake";
import {
  useVideoPromptSessions,
  type VideoPromptPlace,
} from "./videoPromptSessions";
import { useStoryWavesAsk, waitForJob } from "../stores/storyJobStore";
import { ModelPicker } from "../../settings/ModelPicker";
import { clipChoiceKey, useClipChoiceStore } from "../stores/clipChoiceStore";
import { slotAt } from "./takePicks";

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
 * including a rewrite still on its way. Taking that rewrite back is the cancel
 * button's own work, offered only while it is on its way; the corner's ✕ only
 * closes, as clicking outside does.
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
  const cancelRewrite = useVideoPromptSessions((state) => state.cancelRewrite);
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
    values,
    error,
    rewriting,
    rewriteModel,
    issues,
    rewriteError,
  } = session;
  const kind = place.kind === "act" ? "actVideo" : "keyframeVideo";
  const clipPlace =
    place.kind === "act"
      ? {
          kind: "actVideo" as const,
          chapterId: place.chapterId,
          actId: place.actId,
        }
      : {
          kind: "keyframeVideo" as const,
          chapterId: place.chapterId,
          actId: place.actId,
          keyframeId: place.keyframeId ?? "",
        };
  // The guide is the one the words will be held to when they are sent, which
  // is the contract of the model that films the place rather than the step's.
  const act = actAt(live, place.chapterId, place.actId);
  const guide = videoPromptRewrite(
    kind,
    act === undefined ? null : actVideoModel(act),
  );
  // Whether the speakers' own recordings ride with these asks, and where they
  // do not, which of the three repairs is the one: a recording nobody kept, a
  // model that reads none, or a piece too long for the service to hear one.
  const voiceLines =
    place.kind === "act"
      ? (act?.keyframes.flatMap((keyframe) => keyframe.dialogue) ?? [])
      : (act?.keyframes.find((keyframe) => keyframe.id === place.keyframeId)
          ?.dialogue ?? []);
  const carriedVoices = shown.flatMap((ask) => ask.promptContext?.voices ?? []);
  const timings = shown
    .map((ask) => secondsOf(ask.params))
    .filter((seconds) => seconds > 0);
  const voiceNote = (() => {
    if (carriedVoices.length > 0) {
      const names = [...new Set(carriedVoices.map((voice) => voice.name))];
      const ability = act === undefined ? null : actVideoVoiceReference(act);
      return ability?.seconds === null || ability === null
        ? t("story:storyboard.voiceRefsOn", { names: names.join("、") })
        : t("story:storyboard.voiceRefsOnCapped", {
            names: names.join("、"),
            seconds: ability.seconds,
          });
    }
    if (act === undefined || voiceLines.length === 0) return null;
    const outlook = voiceReferenceState(
      live,
      voiceLines,
      timings.length === 0 ? Infinity : Math.min(...timings),
      act,
    );
    if (outlook.state === "noModel")
      return t("story:storyboard.voiceRefsNoModel");
    if (outlook.state === "tooLong")
      return t("story:storyboard.voiceRefsTooLong", {
        seconds: outlook.seconds,
      });
    return null;
  })();

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

  const filmTakes = async (fresh: StoryDocument) => {
    const records: string[] = [];
    for (let round = 0; round < count; round += 1) {
      const waves =
        place.kind === "act"
          ? planActVideoWaves(fresh, place.chapterId, [place.actId])
          : planKeyframeVideoWaves(fresh, place.chapterId, place.actId, [
              place.keyframeId ?? "",
            ]);
      records.push(...(await runArt(story.id, kind, waves)));
    }
    await Promise.all(
      records.map((id) => waitForJob(id).catch(() => undefined)),
    );
    if (count <= 1) return;
    const after = liveStory(story.id) ?? fresh;
    const slot = slotAt(after, clipPlace);
    if (slot !== undefined && slot.takes.length > 1) {
      useClipChoiceStore.getState().mark([clipChoiceKey(story.id, clipPlace)]);
    }
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
      void filmTakes(fresh);
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
        <header className="dialog-head">
          <h2 id="story-video-prompt-title">
            {t("story:storyboard.videoPromptTitle")} · {place.name}
          </h2>
          <button
            aria-label={t("story:panels.close")}
            className="dialog-close"
            data-testid="story-video-prompt-close"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </header>
        <p className="dialog-note">
          {mode === "film"
            ? t("story:storyboard.videoPromptFilmHint")
            : t("story:storyboard.videoPromptHint")}
        </p>

        {voiceNote !== null && (
          <p className="story-hint" data-testid="story-video-prompt-voice-refs">
            {voiceNote}
          </p>
        )}

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

        {/*
          The rewrite stands in a column of its own, with the model it is asked
          of beneath it: the picker governs the rewrite and nothing else, and
          sending stands apart from both.
        */}
        <div className="story-prompt-footer">
          {mode === "film" && guide !== null && (
            <div className="story-prompt-rewrite">
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
              {/* Which text model does the rewriting: the room's own unless the
                  reader names one for this place, and nothing else about the
                  filming changes with it. */}
              <ModelPicker
                capability="text"
                disabled={rewriting}
                label={t("story:storyboard.videoPromptRewriteModel")}
                noneLabel={t("story:storyboard.modelGlobal")}
                onChange={(reference) =>
                  patch(key, { rewriteModel: reference })
                }
                testId="story-video-prompt-model"
                value={rewriteModel}
              />
            </div>
          )}
          <div className="dialog-actions">
            <label
              className="story-draw-count"
              title={t("story:storyboard.videoPromptCountHint")}
            >
              <span>{t("story:storyboard.filmCount")}</span>
              <select
                aria-label={t("story:storyboard.filmCountLabel")}
                data-testid="story-video-prompt-count"
                disabled={rewriting || shown.length === 0}
                onChange={(event) => setCount(Number(event.target.value))}
                value={count}
              >
                {Array.from(
                  { length: MAX_VIDEO_TAKES_PER_ASK },
                  (_, at) => at + 1,
                ).map((each) => (
                  <option key={each} value={each}>
                    {t("story:storyboard.filmCountOption", { count: each })}
                  </option>
                ))}
              </select>
            </label>
            {/* Taking the rewrite back, not closing over it: the words already
                rewritten stay, and the dialog is open to asking again. */}
            {rewriting && (
              <button
                data-testid="story-video-prompt-cancel"
                onClick={() => cancelRewrite(key)}
                type="button"
              >
                {t("story:panels.cancel")}
              </button>
            )}
            <button
              data-testid="story-video-prompt-save"
              disabled={shown.length === 0}
              onClick={() => save(false)}
              type="button"
            >
              {t("story:storyboard.videoPromptSave")}
            </button>
            {mode === "film" ? (
              <button
                className="primary"
                data-testid="story-video-prompt-send"
                disabled={rewriting || shown.length === 0}
                onClick={() => save(true)}
                type="button"
              >
                {t("story:storyboard.videoPromptSend")}
              </button>
            ) : (
              <button
                className="primary"
                data-testid="story-video-prompt-film"
                disabled={shown.length === 0}
                onClick={() => save(true)}
                type="button"
              >
                {t("story:storyboard.videoPromptSaveAndFilm")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
