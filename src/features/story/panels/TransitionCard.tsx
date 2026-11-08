import { useState } from "react";
import { useTranslation } from "react-i18next";

import { assetThumbUrl, assetUrl } from "../../../api/assets";
import {
  DEFAULT_STORY_TRANSITION_MS,
  currentTake,
  transitionFrames,
  type StoryTransition,
} from "../../../shared/domain";
import type {
  StoryAct,
  StoryChapter,
  StoryDocument,
} from "../../../shared/domain/types";
import { RunningBar } from "../components/RunningBar";
import { planActVideos, videoCeiling } from "../jobs/plan";
import { useStoryRun, type ActRun } from "../stores/storyJobStore";
import { liveStory } from "./removeOldTake";
import { StoryLightbox } from "./StoryLightbox";
import { useField } from "./useField";
import { writeActs } from "./writeBoard";

/** The shortest and longest a bridge may be, in seconds. */
const TRANSITION_MIN_S = 1;
const TRANSITION_MAX_S = 60;

/**
 * A bridge between two acts, as a card of its own.
 *
 * It is not a board: there are no shots to write and no pictures to draw. What
 * the card holds is the move and its length, and the two pictures it is filmed
 * between — the frame the act before ends on and the frame the act after begins
 * on, read from those acts rather than copied here. A bridge cannot be filmed
 * until both neighbours have been drawn, and the card says which end it is
 * waiting for rather than offering an ask that would be refused.
 */
export function TransitionCard({
  story,
  chapter,
  act,
  index,
  videoBusy,
  runs,
}: {
  story: StoryDocument;
  chapter: StoryChapter;
  act: StoryAct;
  /** Which act of the chapter this is, counted from zero as the room counts. */
  index: number;
  /** Whether this bridge's clip is being made just now. */
  videoBusy: boolean;
  /** The batches working in this act just now, each with its own clock. */
  runs: ActRun[];
}) {
  const { t } = useTranslation();
  const run = useStoryRun();
  const [playing, setPlaying] = useState(false);
  // The card is only handed a bridge, but the fallback keeps the hooks below
  // unconditional.
  const transition = act.transition ?? {
    prompt: "",
    durationMs: DEFAULT_STORY_TRANSITION_MS,
  };

  const frames = transitionFrames(chapter, index);
  const clip = currentTake(act.video);
  const ceiling = videoCeiling();
  const plannedSeconds = Math.round((transition.durationMs / 1000) * 10) / 10;
  const askedSeconds = Math.min(
    ceiling,
    Math.max(1, Math.round(transition.durationMs / 1000)),
  );
  const adjusted = askedSeconds !== plannedSeconds;
  const ready = frames.from !== undefined && frames.to !== undefined;
  const missing = !ready
    ? t(
        frames.from === undefined
          ? "story:storyboard.transitionMissingFrom"
          : "story:storyboard.transitionMissingTo",
      )
    : undefined;

  const writeTransition = (patch: Partial<StoryTransition>) => {
    writeActs(
      story,
      chapter.id,
      chapter.acts.map((held) =>
        held.id === act.id
          ? { ...held, transition: { ...transition, ...patch } }
          : held,
      ),
    );
  };

  const prompt = useField(transition.prompt, (value) => {
    if (value !== transition.prompt) writeTransition({ prompt: value });
  });
  const length = useField(String(plannedSeconds), (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return;
    const ms = Math.round(
      Math.min(TRANSITION_MAX_S, Math.max(TRANSITION_MIN_S, seconds)) * 1000,
    );
    if (ms !== transition.durationMs) writeTransition({ durationMs: ms });
  });

  const film = () => {
    // The words just typed are written when the field is left, which the press
    // itself may be doing: the ask is planned from the document as it stands.
    const live = liveStory(story.id) ?? story;
    const items = planActVideos(live, chapter.id, [act.id]);
    if (items.length > 0) void run(story.id, "actVideo", items);
  };
  const remove = () =>
    writeActs(
      story,
      chapter.id,
      chapter.acts.filter((held) => held.id !== act.id),
    );

  return (
    <li
      className="story-act story-transition"
      data-testid={`story-transition-${index}`}
    >
      <div className="story-act-head">
        <span className="story-act-index">
          {t("story:storyboard.actIndex", { index: index + 1 })}
        </span>
        <span className="story-transition-name">
          {t("story:storyboard.transitionTitle")}
        </span>
        <span
          className="story-count"
          data-testid={`story-transition-plan-${index}`}
        >
          {t("story:storyboard.plan", { seconds: plannedSeconds })}
        </span>
        {adjusted && (
          <span
            className="story-clamp"
            data-testid={`story-transition-clamp-${index}`}
            title={t("story:storyboard.clampHint", { max: ceiling })}
          >
            {t("story:storyboard.clamped", { seconds: askedSeconds })}
          </span>
        )}
        <span className="story-act-tools">
          <button
            aria-label={t("story:storyboard.transitionRemove")}
            className="story-act-tool is-remove"
            data-testid={`story-transition-remove-${index}`}
            onClick={remove}
            title={t("story:storyboard.transitionRemove")}
            type="button"
          >
            ✕
          </button>
        </span>
      </div>

      {runs.length > 0 && (
        <div className="story-runs">
          {runs.map(({ job, items }) => (
            <RunningBar
              job={job}
              key={job.id}
              label={t("story:jobs.generating")}
              pieces={items}
              testId="story-transition-running"
            />
          ))}
        </div>
      )}

      <div className="story-transition-ends">
        <TransitionEnd
          caption={t("story:storyboard.transitionFrom")}
          frame={frames.from}
          ready={t("story:storyboard.transitionMissingFrom")}
          testId={`story-transition-from-${index}`}
        />
        <TransitionEnd
          caption={t("story:storyboard.transitionTo")}
          frame={frames.to}
          ready={t("story:storyboard.transitionMissingTo")}
          testId={`story-transition-to-${index}`}
        />
      </div>

      <label
        className="story-field-label"
        htmlFor={`transition-prompt-${index}`}
      >
        {t("story:storyboard.transitionPrompt")}
      </label>
      <textarea
        aria-label={t("story:storyboard.transitionPrompt")}
        className="story-act-summary"
        data-testid={`story-transition-prompt-${index}`}
        id={`transition-prompt-${index}`}
        maxLength={2000}
        onBlur={prompt.commit}
        onChange={(event) => prompt.set(event.target.value)}
        placeholder={t("story:storyboard.transitionPromptHint")}
        rows={2}
        value={prompt.value}
      />

      <label className="story-transition-length">
        <span className="story-field-label">
          {t("story:storyboard.transitionSeconds")}
        </span>
        <input
          aria-label={t("story:storyboard.transitionSeconds")}
          data-testid={`story-transition-seconds-${index}`}
          max={TRANSITION_MAX_S}
          min={TRANSITION_MIN_S}
          onBlur={length.commit}
          onChange={(event) => length.set(event.target.value)}
          step={0.5}
          type="number"
          value={length.value}
        />
      </label>

      <div className="story-act-foot">
        {clip === undefined ? (
          <button
            className="primary"
            data-testid={`story-transition-video-go-${index}`}
            disabled={!ready || videoBusy}
            onClick={film}
            title={missing}
            type="button"
          >
            {videoBusy
              ? t("story:panels.drawing")
              : t("story:storyboard.transitionFilm")}
          </button>
        ) : (
          <span className="story-act-clip">
            <button
              aria-label={t("story:storyboard.playClip")}
              className="story-act-play"
              data-testid={`story-transition-video-${index}`}
              onClick={() => setPlaying(true)}
              type="button"
            >
              <video
                muted
                preload="metadata"
                src={assetUrl(clip.assetIds[0])}
              />
            </button>
            <button
              className="link"
              data-testid={`story-transition-video-again-${index}`}
              disabled={!ready || videoBusy}
              onClick={film}
              title={missing}
              type="button"
            >
              {videoBusy
                ? t("story:panels.drawing")
                : t("story:storyboard.transitionAgain")}
            </button>
          </span>
        )}
        {!ready && (
          <span
            className="story-hint"
            data-testid={`story-transition-missing-${index}`}
          >
            {missing}
          </span>
        )}
      </div>

      {playing && clip !== undefined && (
        <StoryLightbox
          assetIds={clip.assetIds}
          label={t("story:storyboard.playClip")}
          onClose={() => setPlaying(false)}
          video
        />
      )}
    </li>
  );
}

/** One end of a bridge: the neighbour's frame, or what it is waiting for. */
function TransitionEnd({
  frame,
  caption,
  ready,
  testId,
}: {
  frame: { assetId: string } | undefined;
  caption: string;
  ready: string;
  testId: string;
}) {
  return (
    <figure className="story-transition-end" data-testid={testId}>
      {frame === undefined ? (
        <span className="story-transition-end-empty">{ready}</span>
      ) : (
        <img alt="" src={assetThumbUrl(frame.assetId, 160)} />
      )}
      <figcaption className="story-hint">{caption}</figcaption>
    </figure>
  );
}
