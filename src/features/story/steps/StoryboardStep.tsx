import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { StoryJobRecord } from "../../../api/story";
import {
  actComplete,
  actsRegenerationCost,
  chunkWaves,
  formatDuration,
  keyframeCount,
  targetKey,
  type StoryAct,
  type StoryChapter,
  type StoryDocument,
  type StoryGuess,
  type StoryShotGranularity,
} from "../../../shared/domain";
import { REFERENCE_IMAGES_MAX } from "../../../shared/domain/constants";
import { createAct } from "../../../shared/domain/factories";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RunningBar } from "../components/RunningBar";
import { StoryModelPicks } from "../components/StoryModelPicks";
import { StoryImportButton } from "../components/StoryImportButton";
import { StepConfirm } from "../components/StepConfirm";
import { ActCard } from "../panels/ActCard";
import { writeActs } from "../panels/writeBoard";
import { chapterGuesses } from "../jobs/apply";
import { jobKey, planKeyframeArt, planStoryboard } from "../jobs/plan";
import {
  actRuns,
  boardRuns,
  kindRunning,
  useStoryJobs,
  useStoryJobStore,
  useStoryRun,
} from "../stores/storyJobStore";
import { useStoryStore } from "../stores/storyStore";
import { useField } from "../panels/useField";

/** How many episodes one batch is asked to board at once. */
const BOARDS_PER_ASK = 8;

/**
 * The fourth step: every episode's board — its acts, their shots, and the
 * pictures and clips made from them.
 *
 * One episode is boarded at a time, because a board is the thing a reader
 * argues with: acts, framing, what is said, and how long each shot runs. The
 * board stays the reader's after it has been read, and a clip is made once
 * every frame of its act is drawn, since the pictures are what it is made from
 * — and nothing is asked for in bulk without saying how many pieces it is.
 *
 * Every picture and every clip is an ask of its own: a shot whose painter is
 * working says so and is not asked for twice, while the shots beside it go on
 * being drawable — and what a batch is making elsewhere in the story does not
 * hold the rest of the board back. Each act says what it is waiting on from its
 * own head, one bar per batch, so two things being made at once are two bars
 * and neither is written over by the other. The one thing that waits on the
 * whole episode is the board itself, which rewrites the acts every drawing
 * stands in — and its bar stands over them rather than in any one of them.
 */
export function StoryboardStep({ story }: { story: StoryDocument }) {
  const { t } = useTranslation();
  const jobs = useStoryJobs(story.id);
  const failure = useStoryJobStore((state) => state.error);
  const run = useStoryRun();
  const openChapterId = useStoryStore((state) => state.openChapterId);
  const [asking, setAsking] = useState(false);
  const [granularityTo, setGranularityTo] =
    useState<StoryShotGranularity | null>(null);
  const [waves, setWaves] = useState<string[][]>([]);
  const [totalWaves, setTotalWaves] = useState(0);
  const starting = useRef(false);

  const index = Math.max(
    0,
    story.chapters.findIndex((held) => held.id === openChapterId),
  );
  const chapter: StoryChapter | undefined = story.chapters[index];
  // The episode's own ask, which is the one thing on this page that waits on
  // the whole board: what the acts are having made is each act's own, and is
  // read off the acts themselves.
  const board = chapter === undefined ? [] : boardRuns(jobs, chapter.id);
  // Every place this page asks about is read off one set: what a batch out for
  // this story is making right now, by the name the place is known by.
  const keys = busyKeys(jobs);
  /** Whether an episode's own board is being written just now. */
  const boarding = (chapterId: string): boolean =>
    keys.has(jobKey({ kind: "storyboard", chapterId }));
  /** Whether one of a shot's own pictures is being made just now. */
  const drawing = (target: {
    chapterId: string;
    actId: string;
    keyframeId: string;
  }): boolean => keys.has(targetKey({ kind: "keyframe", ...target }));
  const marks =
    chapter === undefined
      ? new Map<string, StoryGuess[]>()
      : chapterGuesses(story, chapter.id, jobs);

  const unboarded = story.chapters.filter((held) => held.acts.length === 0);
  // What "board every episode" hands over: the episodes with no board of their
  // own that are not already being written. It is also what the button counts,
  // so its number is the work it would ask for.
  const boardable = unboarded.filter((held) => !boarding(held.id));
  const actsTotal = story.chapters.reduce(
    (sum, held) => sum + held.acts.length,
    0,
  );
  // Frames are asked for from the board as it stands: a shot with no picture
  // is the work there is, and the count leaves out the frames already on their
  // way, since asking for a place twice pays for it twice.
  const missingFrames = story.chapters.flatMap((held) =>
    held.acts.flatMap((act) =>
      act.keyframes
        .filter(
          (keyframe) =>
            keyframe.art.takes.length === 0 &&
            !drawing({
              chapterId: held.id,
              actId: act.id,
              keyframeId: keyframe.id,
            }),
        )
        .map((keyframe) => ({
          chapterId: held.id,
          actId: act.id,
          keyframeId: keyframe.id,
        })),
    ),
  );
  const videos = countVideos(story);
  const completeActs = story.chapters
    .flatMap((held) => held.acts)
    .filter((act) => actComplete(act, story.shotGranularity)).length;

  // A telling longer than one batch is boarded in waves, the next one
  // beginning when the one before it is over rather than when the reader
  // presses again — and only a board holds a board back: what a batch of
  // drawings is making is its own work on its own shots.
  const boardingSomewhere = kindRunning(jobs, "storyboard");
  useEffect(() => {
    if (starting.current || boardingSomewhere || waves.length === 0) return;
    const next = waves[0];
    if (next === undefined) return;
    starting.current = true;
    void useStoryJobStore
      .getState()
      .start(story.id, "storyboard", planStoryboard(story, next))
      .then((record) => {
        setWaves((held) => (record === null ? [] : held.slice(1)));
      })
      .finally(() => {
        starting.current = false;
      });
  }, [boardingSomewhere, waves, story]);

  const writeGranularity = (granularity: StoryShotGranularity) => {
    execute(i18n.t("story:history.storyboard"), [
      {
        type: "updateStoryGranularity",
        storyId: story.id,
        shotGranularity: granularity,
      },
    ]);
  };

  /** An act the reader asked for, standing where they asked for it. */
  const insertAct = (at: number) => {
    const acts = [...(chapter?.acts ?? [])];
    acts.splice(at, 0, createAct(t("story:storyboard.newAct", { at: at + 1 })));
    if (chapter !== undefined) writeActs(story, chapter.id, acts);
  };

  const chooseGranularity = (next: StoryShotGranularity) => {
    if (next === story.shotGranularity) return;
    if (videos > 0) {
      setGranularityTo(next);
      return;
    }
    writeGranularity(next);
  };

  const boardAll = async () => {
    const cut = chunkWaves(
      boardable.map((held) => held.id),
      BOARDS_PER_ASK,
    );
    setTotalWaves(Math.max(1, cut.length));
    setWaves(cut.slice(1));
    const first = cut[0] ?? [];
    if (first.length === 0) return;
    await run(story.id, "storyboard", planStoryboard(story, first));
  };

  if (chapter === undefined) {
    return (
      <div
        className="story-step-scroll"
        data-testid="story-step-storyboard-body"
      >
        <div
          className="clip-empty clip-empty-first"
          data-testid="story-board-nochapters"
        >
          <p>{t("story:storyboard.noChapters")}</p>
          <button
            className="primary"
            data-testid="story-board-to-outline"
            onClick={() => useStoryStore.getState().goStep("outline")}
            type="button"
          >
            {t("story:step.outline")}
          </button>
        </div>
      </div>
    );
  }

  const cost = actsRegenerationCost(chapter);
  // One ask for the board stands in the header whichever state the episode is
  // in: with no board it writes one straight away, and with one standing it
  // takes the name of writing it again and asks first, since that replaces
  // what is there.
  const boarded = chapter.acts.length > 0;

  return (
    <div className="story-step-scroll" data-testid="story-step-storyboard-body">
      <div className="story-step-wide">
        <div className="story-step-bar">
          <p className="story-step-lead">{t("story:storyboard.lead")}</p>
          <StoryImportButton story={story} target="canvas" />
        </div>
        <div className="story-step-bar">
          <StoryModelPicks
            places={["text", "image", "video", "audio", "music"]}
          />
          <ReferenceLimitField story={story} />
        </div>
        <p className="story-hint" data-testid="story-board-audio-fallback">
          {t("story:voice.audioFallback")}
        </p>

        <div className="story-step-bar">
          <span
            aria-label={t("story:storyboard.granularity")}
            className="story-granularity"
            role="radiogroup"
          >
            {STORY_GRANULARITY_OPTIONS.map((option) => (
              <button
                aria-checked={story.shotGranularity === option}
                className={`story-choice${story.shotGranularity === option ? " is-on" : ""}`}
                data-testid={`story-granularity-${option}`}
                key={option}
                onClick={() => chooseGranularity(option)}
                role="radio"
                type="button"
              >
                {t(`story:storyboard.granularity_${option}`)}
              </button>
            ))}
          </span>
          <div className="story-step-actions">
            {missingFrames.length > 0 && (
              <button
                data-testid="story-board-draw-missing"
                onClick={() =>
                  void run(
                    story.id,
                    "keyframeArt",
                    planKeyframeArt(story, missingFrames),
                  )
                }
                type="button"
              >
                {t("story:storyboard.drawAllMissing", {
                  count: missingFrames.length,
                })}
              </button>
            )}
            {boardable.length >= 2 && (
              <button
                data-testid="story-board-all"
                onClick={() => void boardAll()}
                type="button"
              >
                {t("story:storyboard.generateAll", { count: boardable.length })}
              </button>
            )}
            <button
              className="primary"
              data-testid={
                boarded ? "story-board-regenerate" : "story-board-generate"
              }
              disabled={boarding(chapter.id)}
              onClick={() => {
                if (boarded) {
                  setAsking(true);
                  return;
                }
                void run(
                  story.id,
                  "storyboard",
                  planStoryboard(story, [chapter.id]),
                );
              }}
              type="button"
            >
              {t(
                boarded
                  ? "story:storyboard.regenerate"
                  : "story:storyboard.generate",
              )}
            </button>
            <StepConfirm step="storyboard" story={story} />
          </div>
        </div>

        <div className="story-chapter-strip" role="tablist">
          {story.chapters.map((held, at) => {
            const state = boardState(held, story.shotGranularity);
            return (
              <button
                aria-selected={held.id === chapter.id}
                className={`story-choice${held.id === chapter.id ? " is-on" : ""}`}
                data-testid={`story-board-chapter-${at}`}
                key={held.id}
                onClick={() => useStoryStore.getState().openChapter(held.id)}
                role="tab"
                type="button"
              >
                {at + 1}. {held.title}
                <span className="story-hint">
                  {t(state.key, state.values ?? {})}
                </span>
              </button>
            );
          })}
        </div>

        <div className="story-board-head">
          <span className="story-board-name">
            {t("story:storyboard.chapterAt", {
              number: index + 1,
              title: chapter.title,
            })}
          </span>
          <span className="story-count" data-testid="story-board-target">
            {t("story:storyboard.target", {
              duration: formatDuration(chapter.targetDurationMs),
            })}
          </span>
          <span className="story-hint" data-testid="story-board-settled">
            {t("story:storyboard.settled", {
              done: completeActs,
              total: actsTotal,
            })}
          </span>
          {chapter.acts.some(
            (act) => act.voice !== undefined || act.music !== undefined,
          ) && (
            <span className="story-hint" data-testid="story-board-sound">
              {t("story:storyboard.soundReady")}
            </span>
          )}
        </div>

        <div className="story-step-actions">
          {totalWaves > 1 && (board.length > 0 || waves.length > 0) && (
            <span className="story-hint" data-testid="story-board-wave">
              {t("story:outline.wave", {
                at: Math.max(1, totalWaves - waves.length),
                of: totalWaves,
              })}
            </span>
          )}
        </div>

        {failure !== null && (
          <p className="story-hint" data-testid="story-board-error">
            {failure}
          </p>
        )}

        {board.length > 0 && (
          <div className="story-runs">
            {board.map((job) => (
              <RunningBar
                job={job}
                key={job.id}
                label={t("story:storyboard.writing")}
                pieces={job.items}
                testId="story-board-running"
              />
            ))}
          </div>
        )}

        {chapter.acts.length === 0 ? (
          <div className="clip-empty" data-testid="story-board-empty">
            <p>{t("story:storyboard.empty")}</p>
            <div className="story-step-actions">
              <button
                data-testid="story-act-insert-0"
                onClick={() => insertAct(0)}
                type="button"
              >
                {t("story:storyboard.insertAct")}
              </button>
            </div>
          </div>
        ) : (
          <ol className="story-acts">
            {chapter.acts.map((act, at) => {
              const busy = busyIn(keys, chapter.id, act);
              return (
                <Fragment key={act.id}>
                  {/*
                    An act goes where the reader points rather than only after
                    the last one: a row stands above every act — and one under
                    them all — so an episode being reworked grows at the seam
                    the new act belongs to.
                  */}
                  <li className="story-insert">
                    <button
                      data-testid={`story-act-insert-${at}`}
                      onClick={() => insertAct(at)}
                      type="button"
                    >
                      {t("story:storyboard.insertAct")}
                    </button>
                  </li>
                  <ActCard
                    act={act}
                    busyKeyframes={busy.frames}
                    busyClips={busy.clips}
                    busyLines={busy.lines}
                    chapterId={chapter.id}
                    guesses={marks.get(act.id) ?? []}
                    index={at}
                    last={at === chapter.acts.length - 1}
                    musicBusy={busy.music}
                    runs={actRuns(jobs, chapter.id, act.id)}
                    story={story}
                    videoBusy={busy.video}
                    voiceBusy={busy.voice}
                  />
                </Fragment>
              );
            })}
            <li className="story-insert">
              <button
                data-testid={`story-act-insert-${chapter.acts.length}`}
                onClick={() => insertAct(chapter.acts.length)}
                type="button"
              >
                {t("story:storyboard.insertAct")}
              </button>
            </li>
          </ol>
        )}
      </div>

      {asking && (
        <ConfirmDialog
          body={t("story:storyboard.regenerateBody", {
            acts: cost.acts,
            drawn: cost.drawn,
            filmed: cost.filmed,
          })}
          confirm={t("story:storyboard.regenerateConfirm")}
          note={t("story:storyboard.regenerateNote")}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            void run(
              story.id,
              "storyboard",
              planStoryboard(story, [chapter.id]),
            );
          }}
          testId="regenerate-board"
          title={t("story:storyboard.regenerateTitle", { number: index + 1 })}
        />
      )}
      {granularityTo !== null && (
        <ConfirmDialog
          body={t("story:storyboard.granularityBody", {
            count: videos,
            from: t(`story:storyboard.granularity_${story.shotGranularity}`),
            to: t(`story:storyboard.granularity_${granularityTo}`),
          })}
          confirm={t("story:storyboard.granularityConfirm")}
          note={t("story:storyboard.granularityNote")}
          onCancel={() => setGranularityTo(null)}
          onConfirm={() => {
            writeGranularity(granularityTo);
            setGranularityTo(null);
          }}
          testId="change-granularity"
          title={t("story:storyboard.granularityTitle")}
        />
      )}
    </div>
  );
}

/**
 * How many of a shot's mentioned pictures its ask may carry.
 *
 * The number stands beside the models because it belongs to the ask the same
 * way they do: one shape of image model takes three reference pictures and
 * another nine, and the service refuses the whole request over the bound
 * rather than drawing with the first of them.
 */
function ReferenceLimitField({ story }: { story: StoryDocument }) {
  const { t } = useTranslation();
  const limit = useField(String(story.maxReferenceImages), (value) => {
    const count = Number(value);
    if (!Number.isInteger(count)) return;
    const clamped = Math.min(REFERENCE_IMAGES_MAX, Math.max(0, count));
    if (clamped === story.maxReferenceImages) return;
    execute(i18n.t("story:history.storyboard"), [
      {
        type: "updateStoryReferenceLimit",
        storyId: story.id,
        maxReferenceImages: clamped,
      },
    ]);
  });
  return (
    <label className="story-model" data-testid="story-ref-limit">
      <span className="story-hint">{t("story:storyboard.maxRefs")}</span>
      <input
        aria-label={t("story:storyboard.maxRefs")}
        data-testid="story-max-refs"
        max={REFERENCE_IMAGES_MAX}
        min={0}
        onBlur={limit.commit}
        onChange={(event) => limit.set(event.target.value)}
        step={1}
        title={t("story:storyboard.maxRefsHint")}
        type="number"
        value={limit.value}
      />
    </label>
  );
}

/** The two ways a board's clips may be made, in the order the room shows them. */
const STORY_GRANULARITY_OPTIONS: StoryShotGranularity[] = ["act", "keyframe"];

/** What an episode's chip says about how far its board has got. */
function boardState(
  chapter: StoryChapter,
  granularity: StoryShotGranularity,
): { key: string; values?: Record<string, number> } {
  if (chapter.acts.length === 0) return { key: "story:storyboard.chipEmpty" };
  if (chapter.acts.every((act) => actComplete(act, granularity))) {
    return { key: "story:storyboard.chipFilmed" };
  }
  const drawn = chapter.acts.reduce(
    (sum, act) =>
      sum +
      act.keyframes.filter((keyframe) => keyframe.art.takes.length > 0).length,
    0,
  );
  if (drawn > 0) {
    return {
      key: "story:storyboard.chipFrames",
      values: { drawn, total: keyframeCount(chapter) },
    };
  }
  return {
    key: "story:storyboard.chipBoarded",
    values: { acts: chapter.acts.length },
  };
}

/** How many clips a story holds, wherever they were made. */
function countVideos(story: StoryDocument): number {
  return story.chapters
    .flatMap((chapter) => chapter.acts)
    .reduce(
      (sum, act) =>
        sum +
        (act.video.takes.length > 0 ? 1 : 0) +
        act.keyframes.filter((keyframe) => keyframe.video.takes.length > 0)
          .length,
      0,
    );
}

/** The places a batch is working on right now, by the name a place is known by. */
function busyKeys(jobs: StoryJobRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const job of jobs) {
    for (const item of job.items) {
      if (item.status === "queued" || item.status === "running") {
        keys.add(jobKey(item.target));
      }
    }
  }
  return keys;
}

/**
 * Which of an act's shots are being drawn or filmed, and whether its own clip,
 * its lines or its score are being made — one place at a time, since one batch
 * making one of them says nothing about the others.
 */
function busyIn(
  keys: Set<string>,
  chapterId: string,
  act: StoryAct,
): {
  frames: Set<string>;
  clips: Set<string>;
  lines: Set<string>;
  video: boolean;
  voice: boolean;
  music: boolean;
} {
  const frames = new Set<string>();
  const clips = new Set<string>();
  const lines = new Set<string>();
  const video = keys.has(
    targetKey({ kind: "actVideo", chapterId, actId: act.id }),
  );
  const music = keys.has(
    targetKey({ kind: "actMusic", chapterId, actId: act.id }),
  );
  for (const keyframe of act.keyframes) {
    for (const line of keyframe.dialogue) {
      if (
        keys.has(
          targetKey({
            kind: "lineVoice",
            chapterId,
            actId: act.id,
            keyframeId: keyframe.id,
            lineId: line.id,
          }),
        )
      ) {
        lines.add(line.id);
      }
    }
    if (
      keys.has(
        targetKey({
          kind: "keyframe",
          chapterId,
          actId: act.id,
          keyframeId: keyframe.id,
        }),
      )
    ) {
      frames.add(keyframe.id);
    }
    if (
      keys.has(
        targetKey({
          kind: "keyframeVideo",
          chapterId,
          actId: act.id,
          keyframeId: keyframe.id,
        }),
      )
    ) {
      clips.add(keyframe.id);
    }
  }
  // The act's voice row is at work while any of its lines is being read, and
  // while its old whole-act reading is being made: the two sit on one row.
  const voice =
    lines.size > 0 ||
    keys.has(targetKey({ kind: "actVoice", chapterId, actId: act.id }));
  return { frames, clips, lines, video, voice, music };
}
