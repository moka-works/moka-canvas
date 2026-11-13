import { useState } from "react";
import { useTranslation } from "react-i18next";

import { assetFrameUrl, assetThumbUrl } from "../../../api/assets";
import {
  DEFAULT_STORY_TRANSITION_MS,
  currentTake,
  neighbourVideos,
  takeFile,
  type StoryTransition,
} from "../../../shared/domain";
import type {
  StoryAct,
  StoryChapter,
  StoryDocument,
} from "../../../shared/domain/types";
import { RunningBar } from "../components/RunningBar";
import { planActVideos, jobKey, videoCeiling } from "../jobs/plan";
import { useStoryRun, type ActRun } from "../stores/storyJobStore";
import { keepTake, removeTake, type TakePlace } from "./takePicks";
import { liveStory } from "./removeOldTake";
import { frameRatio } from "./ratios";
import { StoryLightbox } from "./StoryLightbox";
import { StoryPicks } from "./StoryPicks";
import { useField } from "./useField";
import { videoPromptRewrite } from "../jobs/promptRewrite";
import { VideoPromptDialog } from "./VideoPromptDialog";
import { writeActs } from "./writeBoard";

/** The shortest and longest a bridge may be, in seconds. */
const TRANSITION_MIN_S = 1;
const TRANSITION_MAX_S = 60;

/** How wide a bridge's clip poster is asked for: its preview is drawn 160 px. */
const TRANSITION_POSTER_WIDTH = 320;

/**
 * A bridge between two acts, as a card of its own.
 *
 * It is not a board: there are no shots to write and no pictures to draw. What
 * the card holds is the move and its length, and the two pictures it is filmed
 * between — the last frame of the act before it and the first frame of the act
 * after it, taken out of their own clips. A bridge cannot be filmed until both
 * neighbours have been filmed, and the card says which end it is waiting for
 * rather than offering an ask that would be refused.
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
  const [pickingClip, setPickingClip] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<"edit" | "film" | null>(
    null,
  );
  // The card is only handed a bridge, but the fallback keeps the hooks below
  // unconditional.
  const transition = act.transition ?? {
    prompt: "",
    durationMs: DEFAULT_STORY_TRANSITION_MS,
  };

  /** The story as the store holds it now, with this bridge's place in it. */
  const readLive = () => {
    const doc = liveStory(story.id) ?? story;
    const heldChapter = doc.chapters.find((held) => held.id === chapter.id);
    const at = heldChapter?.acts.findIndex((held) => held.id === act.id) ?? -1;
    if (heldChapter === undefined || at < 0) return undefined;
    return { doc, chapter: heldChapter, at };
  };

  /** A field of the bridge written onto the document as it stands now. */
  const writeTransition = (patch: Partial<StoryTransition>) => {
    const held = readLive();
    const current = held?.chapter.acts[held.at]?.transition;
    if (held === undefined || current === undefined) return;
    writeActs(
      held.doc,
      chapter.id,
      held.chapter.acts.map((each) =>
        each.id === act.id
          ? { ...each, transition: { ...current, ...patch } }
          : each,
      ),
    );
  };

  const videos = neighbourVideos(story, chapter, index);
  const ready = videos.from !== undefined && videos.to !== undefined;
  const missing =
    videos.from === undefined
      ? t("story:storyboard.transitionVideoMissingFrom")
      : videos.to === undefined
        ? t("story:storyboard.transitionVideoMissingTo")
        : undefined;

  const clip = currentTake(act.video);
  const promptId = jobKey({
    kind: "actVideo",
    chapterId: chapter.id,
    actId: act.id,
  });
  const promptEdited = story.videoPromptOverrides?.[promptId] !== undefined;
  const clipPlace: TakePlace = {
    kind: "actVideo",
    chapterId: chapter.id,
    actId: act.id,
  };
  // The bridge is filmed from the picture it starts at: its own first frame
  // once it is made, and the neighbour's last until then.
  const clipPoster =
    clip?.assetIds[0] !== undefined
      ? assetThumbUrl(clip.assetIds[0], TRANSITION_POSTER_WIDTH)
      : videos.from === undefined
        ? undefined
        : assetFrameUrl(videos.from.assetId, "last", TRANSITION_POSTER_WIDTH);
  const ceiling = videoCeiling();
  const plannedSeconds = Math.round((transition.durationMs / 1000) * 10) / 10;
  const askedSeconds = Math.min(
    ceiling,
    Math.max(1, Math.round(transition.durationMs / 1000)),
  );
  const adjusted = askedSeconds !== plannedSeconds;

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
    // A model with a prompt contract is asked over words the reader has seen.
    if (videoPromptRewrite("actVideo") !== null) {
      setEditingPrompt("film");
      return;
    }
    // The words just typed are written when the field is left, which the
    // press itself may be doing: the ask is planned from the document as it
    // stands.
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

      {/*
        The two ends are the neighbours' own clips: the last frame of the act
        before and the first frame of the act after, taken out of the clips
        when the move is made. A neighbour that has not been filmed has no end
        to offer, and the card says which one it is waiting for.
      */}
      <div className="story-transition-ends">
        <TransitionEnd
          caption={t("story:storyboard.transitionFromVideo")}
          ready={t("story:storyboard.transitionVideoMissingFrom")}
          src={
            videos.from === undefined
              ? undefined
              : assetFrameUrl(videos.from.assetId, "last", 160)
          }
          testId={`story-transition-from-${index}`}
        />
        <TransitionEnd
          caption={t("story:storyboard.transitionToVideo")}
          ready={t("story:storyboard.transitionVideoMissingTo")}
          src={
            videos.to === undefined
              ? undefined
              : assetFrameUrl(videos.to.assetId, "first", 160)
          }
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
              <img
                alt=""
                decoding="async"
                src={clipPoster}
                style={{ aspectRatio: frameRatio(story) }}
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
            {act.video.takes.length > 1 && (
              <button
                className="link"
                data-testid={`story-transition-video-pick-${index}`}
                onClick={() => setPickingClip(true)}
                type="button"
              >
                {t("story:panels.pickClip")}
              </button>
            )}
          </span>
        )}
        {ready && (
          <button
            className="link"
            data-testid={`story-transition-video-prompt-${index}`}
            onClick={() => setEditingPrompt("edit")}
            type="button"
          >
            {t("story:storyboard.videoPromptEdit")}
            {promptEdited
              ? ` · ${t("story:storyboard.videoPromptEdited")}`
              : ""}
          </button>
        )}
        {missing !== undefined && (
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
          poster={clipPoster}
          video
        />
      )}

      {pickingClip && clip !== undefined && (
        <StoryPicks
          current={takeFile(clip)}
          kind="clip"
          label={t("story:storyboard.transitionTitle")}
          onChoose={(assetId) => {
            keepTake(story.id, clipPlace, assetId);
            setPickingClip(false);
          }}
          onClose={() => setPickingClip(false)}
          onRemove={(assetId) => removeTake(story.id, clipPlace, assetId)}
          takes={act.video.takes}
        />
      )}
      {editingPrompt !== null && (
        <VideoPromptDialog
          mode={editingPrompt}
          onClose={() => setEditingPrompt(null)}
          place={{
            kind: "act",
            chapterId: chapter.id,
            actId: act.id,
            name: t("story:storyboard.videoPromptTransition", {
              index: index + 1,
            }),
          }}
          story={story}
        />
      )}
    </li>
  );
}

/** One end of a bridge: the neighbour's picture, or what it is waiting for. */
function TransitionEnd({
  src,
  caption,
  ready,
  testId,
}: {
  src: string | undefined;
  caption: string;
  ready: string;
  testId: string;
}) {
  return (
    <figure className="story-transition-end" data-testid={testId}>
      {src === undefined ? (
        <span className="story-transition-end-empty">{ready}</span>
      ) : (
        <img alt="" src={src} />
      )}
      <figcaption className="story-hint">{caption}</figcaption>
    </figure>
  );
}
