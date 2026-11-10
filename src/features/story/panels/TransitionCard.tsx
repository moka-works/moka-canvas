import { useState } from "react";
import { useTranslation } from "react-i18next";

import { assetsApi, assetThumbUrl } from "../../../api/assets";
import { errorText } from "../../../api/client";
import {
  DEFAULT_STORY_TRANSITION_MS,
  STORY_TRANSITION_SOURCES,
  currentTake,
  neighbourVideos,
  transitionFrames,
  type StoryTransition,
  type StoryTransitionSource,
} from "../../../shared/domain";
import type {
  StoryAct,
  StoryChapter,
  StoryDocument,
} from "../../../shared/domain/types";
import { useAppStore } from "../../editor/stores/appStore";
import { saveTrouble, useProjectStore } from "../../editor/stores/projectStore";
import { RunningBar } from "../components/RunningBar";
import { planActVideos, videoCeiling } from "../jobs/plan";
import { useStoryRun, type ActRun } from "../stores/storyJobStore";
import { liveStory } from "./removeOldTake";
import { frameRatio } from "./ratios";
import { StoryLightbox } from "./StoryLightbox";
import { useField } from "./useField";
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
  const [fetching, setFetching] = useState(false);
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

  const source = transition.frameSource ?? "keyframes";
  const videos = neighbourVideos(story, chapter, index);
  const cached = transition.cached;
  // A cached pair is the ends only while the clips it was cut from are the
  // clips standing beside the bridge now.
  const cacheFresh =
    source !== "video" ||
    (videos.from !== undefined &&
      videos.to !== undefined &&
      cached?.from !== undefined &&
      cached.to !== undefined &&
      cached.from.videoAssetId === videos.from.assetId &&
      cached.to.videoAssetId === videos.to.assetId);
  const shotEnds = transitionFrames(chapter, index);
  const frames =
    source === "video"
      ? {
          from: cacheFresh ? cached?.from : undefined,
          to: cacheFresh ? cached?.to : undefined,
        }
      : shotEnds;
  const ready = frames.from !== undefined && frames.to !== undefined;
  const videosReady = videos.from !== undefined && videos.to !== undefined;
  const canFilm = source === "video" ? videosReady : ready;
  const missing =
    source === "video"
      ? videos.from === undefined
        ? t("story:storyboard.transitionVideoMissingFrom")
        : videos.to === undefined
          ? t("story:storyboard.transitionVideoMissingTo")
          : cacheFresh
            ? undefined
            : t("story:storyboard.transitionFramesPending")
      : shotEnds.from === undefined
        ? t("story:storyboard.transitionMissingFrom")
        : shotEnds.to === undefined
          ? t("story:storyboard.transitionMissingTo")
          : undefined;

  const fromCaption = t(
    source === "video"
      ? "story:storyboard.transitionFromVideo"
      : "story:storyboard.transitionFrom",
  );
  const toCaption = t(
    source === "video"
      ? "story:storyboard.transitionToVideo"
      : "story:storyboard.transitionTo",
  );

  const clip = currentTake(act.video);
  // The bridge is filmed from the picture it starts at.
  const clipPoster =
    frames.from === undefined
      ? undefined
      : assetThumbUrl(frames.from.assetId, TRANSITION_POSTER_WIDTH);
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

  /**
   * The neighbouring clips' ends, cut out and filed as pictures.
   *
   * The request is one clip at a time rather than both at once because the
   * filed pictures come back with the document revision each one moved, and
   * folding them in out of order would leave the window behind the server.
   */
  const takeFrames = async (): Promise<boolean> => {
    // The pictures are filed on the server, which names them in the document
    // it holds: what the room has open but not saved goes first, the way every
    // picture from this computer does.
    await useProjectStore.getState().flush();
    const after = useProjectStore.getState();
    if (after.pending.length > 0 || after.saveStatus === "conflicted") {
      const blocked = saveTrouble();
      useAppStore
        .getState()
        .pushToast("error", blocked.message, undefined, blocked.detail);
      return false;
    }
    const held = readLive();
    if (held === undefined) return false;
    const ends = neighbourVideos(held.doc, held.chapter, held.at);
    if (ends.from === undefined || ends.to === undefined) return false;
    setFetching(true);
    try {
      const from = await assetsApi.extractFrame(ends.from.assetId, "last");
      useProjectStore.getState().integrateAssetEntry(from.entry, {
        revision: from.revision,
        updatedAt: from.updatedAt,
      });
      const to = await assetsApi.extractFrame(ends.to.assetId, "first");
      useProjectStore.getState().integrateAssetEntry(to.entry, {
        revision: to.revision,
        updatedAt: to.updatedAt,
      });
      // The reader may have put the bridge back on its shots' frames while the
      // clips were being read: the pictures are still filed, but a choice made
      // after the request is the one that stands.
      const latest = readLive();
      const chosen =
        latest?.chapter.acts[latest.at]?.transition?.frameSource ?? "keyframes";
      if (latest === undefined || chosen !== "video") return true;
      writeTransition({
        frameSource: "video",
        cached: {
          from: { assetId: from.entry.id, videoAssetId: ends.from.assetId },
          to: { assetId: to.entry.id, videoAssetId: ends.to.assetId },
        },
      });
      return true;
    } catch (problem) {
      const trouble = errorText(problem);
      useAppStore
        .getState()
        .pushToast(
          "error",
          t("story:storyboard.transitionFramesFailed"),
          undefined,
          trouble.detail ?? trouble.message,
        );
      return false;
    } finally {
      setFetching(false);
    }
  };

  const chooseSource = (next: StoryTransitionSource) => {
    if (next === source) return;
    writeTransition({ frameSource: next });
    if (next === "video") void takeFrames();
  };

  const film = () => {
    void (async () => {
      const held = readLive();
      if (held === undefined) return;
      const current = held.chapter.acts[held.at]?.transition;
      if (current === undefined) return;
      if ((current.frameSource ?? "keyframes") === "video") {
        const ends = neighbourVideos(held.doc, held.chapter, held.at);
        const fresh =
          ends.from !== undefined &&
          ends.to !== undefined &&
          current.cached?.from?.videoAssetId === ends.from.assetId &&
          current.cached?.to?.videoAssetId === ends.to.assetId;
        if (!fresh && !(await takeFrames())) return;
      }
      // The words just typed are written when the field is left, which the
      // press itself may be doing: the ask is planned from the document as it
      // stands.
      const live = liveStory(story.id) ?? story;
      const items = planActVideos(live, chapter.id, [act.id]);
      if (items.length > 0) void run(story.id, "actVideo", items);
    })();
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
        Where the two ends come from. The shots' own frames are the default and
        need nothing made first; the clips' ends are read from the neighbours'
        finished takes, which the machine's renderer cuts out of a video.
      */}
      <span
        className="story-transition-source"
        role="radiogroup"
        aria-label={t("story:storyboard.transitionSource")}
      >
        <span className="story-field-label">
          {t("story:storyboard.transitionSource")}
        </span>
        {STORY_TRANSITION_SOURCES.map((option) => (
          <button
            aria-checked={source === option}
            className={`story-choice${source === option ? " is-on" : ""}`}
            data-testid={`story-transition-source-${option}-${index}`}
            key={option}
            onClick={() => chooseSource(option)}
            role="radio"
            type="button"
          >
            {t(
              option === "keyframes"
                ? "story:storyboard.transitionSourceKeyframes"
                : "story:storyboard.transitionSourceVideo",
            )}
          </button>
        ))}
      </span>

      <div className="story-transition-ends">
        <TransitionEnd
          caption={fromCaption}
          frame={frames.from}
          ready={
            source === "video"
              ? t("story:storyboard.transitionFramesPending")
              : t("story:storyboard.transitionMissingFrom")
          }
          testId={`story-transition-from-${index}`}
        />
        <TransitionEnd
          caption={toCaption}
          frame={frames.to}
          ready={
            source === "video"
              ? t("story:storyboard.transitionFramesPending")
              : t("story:storyboard.transitionMissingTo")
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
            disabled={!canFilm || videoBusy || fetching}
            onClick={film}
            title={missing}
            type="button"
          >
            {videoBusy
              ? t("story:panels.drawing")
              : fetching
                ? t("story:storyboard.transitionFetching")
                : source === "video" && !cacheFresh
                  ? t("story:storyboard.transitionFetchAndFilm")
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
              disabled={!canFilm || videoBusy || fetching}
              onClick={film}
              title={missing}
              type="button"
            >
              {videoBusy
                ? t("story:panels.drawing")
                : fetching
                  ? t("story:storyboard.transitionFetching")
                  : source === "video" && !cacheFresh
                    ? t("story:storyboard.transitionFetchAndFilm")
                    : t("story:storyboard.transitionAgain")}
            </button>
          </span>
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
