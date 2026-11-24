import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  actComplete,
  actGranularity,
  actHasPicturelessShot,
  actsRegenerationCost,
  chapterBoardRevision,
  chapterBoarded,
  chapterOutlineAhead,
  chapterRevision,
  chunkWaves,
  formatDuration,
  frameSettled,
  keyframeCount,
  missingVideoTargets,
  targetKey,
  type StoryAct,
  type StoryChapter,
  type StoryDocument,
  type StoryGuess,
  type StoryShotGranularity,
} from "../../../shared/domain";
import {
  MAX_VIDEO_TAKES_PER_ASK,
  REFERENCE_IMAGES_MAX,
} from "../../../shared/domain/constants";
import { createAct } from "../../../shared/domain/factories";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { useAppStore } from "../../editor/stores/appStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { modelNameOf, useModelStore } from "../../settings/modelStore";
import { BudgetHint } from "../components/BudgetHint";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DrawCountButton } from "../components/DrawCountButton";
import { OutlineRevisionDialog } from "../components/OutlineRevisionDialog";
import { OutlineSyncDialog } from "../components/OutlineSyncDialog";
import { RunningBar } from "../components/RunningBar";
import { StoryModelPicks } from "../components/StoryModelPicks";
import { FoldChevron } from "../components/StoryIcons";
import { StoryImportButton } from "../components/StoryImportButton";
import { StepConfirm } from "../components/StepConfirm";
import { ActCard } from "../panels/ActCard";
import { TransitionCard } from "../panels/TransitionCard";
import { addTransitionAt, mergeActsAt, writeActs } from "../panels/writeBoard";
import { chapterStripWindow } from "./chapterStrip";
import { chapterGuesses } from "../jobs/apply";
import {
  jobKey,
  planActPlan,
  planContinuity,
  planKeyframeArtWaves,
  planMissingVideoWaves,
  planOutlineRevision,
} from "../jobs/plan";
import { runBoards } from "../jobs/boardRun";
import { busyPlaces, mergePlaces, type PlaceBusy } from "../jobs/places";
import {
  actVideoPromptDrifted,
  driftedFrameTargets,
  promptSnapshots,
} from "../panels/promptDrift";
import { planStaleRedraw } from "../panels/stalePlan";
import {
  applyRevision,
  pendingRevision,
  revisionItemOf,
  revisionRuns,
  type RevisionAnswer,
  type RevisionSelection,
} from "../jobs/revision";
import {
  actRuns,
  boardRuns,
  kindRunning,
  useStoryJobs,
  useStoryJobStore,
  useStoryRun,
  useStoryWavesAsk,
  waitForJob,
} from "../stores/storyJobStore";
import {
  rememberStripFold,
  stripFoldAt,
  useStoryStore,
} from "../stores/storyStore";
import { useField } from "../panels/useField";
import { liveStory } from "../panels/removeOldTake";
import { slotAt } from "../panels/takePicks";
import { clipChoiceKey, useClipChoiceStore } from "../stores/clipChoiceStore";
import { usePromptRewrite } from "./usePromptRewrite";
import { useVideoPromptRewrite } from "./useVideoPromptRewrite";

/** How many episodes one batch is asked to board at once. */
const BOARDS_PER_ASK = 8;

function toast(kind: "info" | "success" | "error", message: string): void {
  useAppStore.getState().pushToast(kind, message);
}

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
  const runArt = useStoryWavesAsk();
  const openChapterId = useStoryStore((state) => state.openChapterId);
  const resources = useProjectStore((state) => state.moka?.resources);
  const models = useModelStore((state) => state.view);
  const [asking, setAsking] = useState(false);
  // How many pictures one bulk press draws for each frame, and whether the
  // press asks a text model to rewrite each frame's words for its picture
  // model first. The words are rewritten once per frame, however many pictures
  // the set holds.
  const [imageCount, setImageCount] = useState(1);
  const [rewritePrompts, setRewritePrompts] = useState(false);
  // The same two choices for the clips: how many takes one press films for
  // each place, and whether each take's words are rewritten before it is
  // filmed. A take's words are its own, so a press asks the text model once
  // per take rather than once for the whole set.
  const [videoCount, setVideoCount] = useState(1);
  const [rewriteClips, setRewriteClips] = useState(false);
  const {
    state: rewritingClips,
    prepare: prepareClips,
    cancel: stopRewritingClips,
  } = useVideoPromptRewrite();
  const stoppedClips = useRef(false);
  const {
    state: rewriting,
    prepare: preparePrompts,
    cancel: stopRewriting,
  } = usePromptRewrite();
  const [granularityTo, setGranularityTo] =
    useState<StoryShotGranularity | null>(null);
  const [staleOpen, setStaleOpen] = useState(false);
  const [staleRunning, setStaleRunning] = useState(false);
  const staleStop = useRef(false);
  const [waves, setWaves] = useState<string[][]>([]);
  const [totalWaves, setTotalWaves] = useState(0);
  // The two questions a board whose outline has moved on asks: how it follows
  // the outline, and what the answer would change.
  const [syncOpen, setSyncOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  // Whether the strip of episodes stands open. Folded it keeps the episode
  // the board below belongs to, which is the one thing about the list that is
  // still worth a line while its chips are away. A place on the page rather
  // than a thing the document keeps, remembered with the interface's other
  // choices so the board opens as it was left.
  const [stripOpen, setStripOpen] = useState(() => !stripFoldAt(story.id));
  const starting = useRef(false);

  const index = Math.max(
    0,
    story.chapters.findIndex((held) => held.id === openChapterId),
  );
  const chapter: StoryChapter | undefined = story.chapters[index];
  // What the board's words would ask for now, against what the filed pictures
  // and clips were asked with: a revision changes the first and not the second.
  const snapshots = useMemo(() => promptSnapshots(resources), [resources]);
  const driftedTargets = useMemo(
    () =>
      chapter === undefined
        ? []
        : driftedFrameTargets(story, chapter, snapshots),
    [story, chapter, snapshots],
  );
  const driftedFrames = useMemo(
    () => new Set(driftedTargets.map((target) => target.keyframeId)),
    [driftedTargets],
  );
  // The episode's own ask, which is the one thing on this page that waits on
  // the whole board: what the acts are having made is each act's own, and is
  // read off the acts themselves.
  const board = chapter === undefined ? [] : boardRuns(jobs, chapter.id);
  // Every place this page asks about is read off one set: what a batch out for
  // this story is making right now, by the name the place is known by — and
  // whether it holds a slot or is still waiting for one.
  const places = busyPlaces(jobs);
  // What a press would redraw to bring the board up to the telling: frames
  // whose elements have moved on, and clips left behind by newer frames.
  const stale = planStaleRedraw(story, new Set(places.keys()));
  const staleTotal = stale.frames.length + stale.clips.length;
  const staleElements = new Set(stale.frames.flatMap((frame) => frame.elements))
    .size;
  /** Whether an episode's own board is being written just now. */
  const boarding = (chapterId: string): boolean =>
    places.has(jobKey({ kind: "storyboard", chapterId }));
  /** Whether one of a shot's own pictures is being made just now. */
  const drawing = (target: {
    chapterId: string;
    actId: string;
    keyframeId: string;
  }): boolean => places.has(targetKey({ kind: "keyframe", ...target }));
  const marks =
    chapter === undefined
      ? new Map<string, StoryGuess[]>()
      : chapterGuesses(story, chapter.id, jobs);

  const unboarded = story.chapters.filter((held) => !chapterBoarded(held));
  // What "board every episode" hands over: the episodes with no board of their
  // own that are not already being written. It is also what the button counts,
  // so its number is the work it would ask for.
  const boardable = unboarded.filter((held) => !boarding(held.id));
  const boardedChapters = story.chapters.filter((held) => chapterBoarded(held));
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
            !frameSettled(keyframe) &&
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
  // The clips a bulk press would film: the acts whose pictures all stand and
  // which hold no clip yet, the shots of a keyframe act short of one, and the
  // bridges whose neighbours have both been filmed. A place already being
  // filmed, or an act still waiting on a drawing, is not offered again.
  const missingClips = missingVideoTargets(story, new Set(places.keys()));
  // A bridge keeps its clip whichever granularity is in force, so it is not a
  // clip a switch would strand.
  const videos = countVideos(
    story,
    (act) => act.shotGranularity === undefined && act.transition === undefined,
  );
  const completeActs = story.chapters
    .flatMap((held) => held.acts)
    .filter((act) =>
      actComplete(act, actGranularity(act, story.shotGranularity)),
    ).length;
  // A shot said to need no picture has no frame for a shot-at-a-time clip to
  // open on, so a default that would reach such an act cannot be made
  // shot-at-a-time. Acts with a choice of their own are not the default's to
  // move, which is what the switch is told here.
  const pinnedByPictures = story.chapters.some((held) =>
    held.acts.some(
      (act) =>
        act.transition === undefined &&
        act.shotGranularity === undefined &&
        actHasPicturelessShot(act),
    ),
  );

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
    void runBoards(story.id, next)
      .then(({ asked }) => {
        setWaves((held) => (asked ? held.slice(1) : []));
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
    if (next === "keyframe" && pinnedByPictures) return;
    if (videos > 0) {
      setGranularityTo(next);
      return;
    }
    writeGranularity(next);
  };

  /**
   * Settles the revision proposals a rewrite makes moot: a board written again
   * from the outline has no use for a patch to the board it replaces.
   */
  const settleRevisions = async (chapterIds: string[]) => {
    for (const chapterId of chapterIds) {
      for (const job of jobs) {
        if (job.kind !== "outlineRevision" || job.readAt !== undefined) {
          continue;
        }
        if (revisionItemOf(job, chapterId) === undefined) continue;
        await useStoryJobStore.getState().markRevisionRead(job.id);
      }
    }
  };

  /** Boards these episodes. */
  const boardEpisodes = async (chapterIds: string[]) => {
    await settleRevisions(chapterIds);
    await runBoards(story.id, chapterIds);
  };

  /** Plans the acts of a chapter, or one act of it again, before its shots. */
  const planActs = async (chapterId: string, actId?: string) => {
    if (kindRunning(jobs, "actPlan")) return;
    const planned = planActPlan(story, chapterId, actId);
    if (planned === undefined) return;
    await run(story.id, "actPlan", [planned]);
  };

  /** Checks the staging of these episodes' boards, one ask each. */
  const checkContinuity = async (chapterIds: string[]) => {
    const items = chapterIds.flatMap((chapterId) => {
      const planned = planContinuity(story, chapterId);
      return planned === undefined ? [] : [planned];
    });
    if (items.length === 0) {
      toast("info", t("story:storyboard.continuityNothing"));
      return;
    }
    await run(story.id, "continuity", items);
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
    await boardEpisodes(first);
  };

  /** Asks for a proposal for one chapter from its newer outline. */
  const startRevision = async (chapterId: string) => {
    setSyncOpen(false);
    setPreviewId(null);
    await settleRevisions([chapterId]);
    const planned = planOutlineRevision(story, chapterId);
    if (planned === undefined) return;
    await run(story.id, "outlineRevision", [planned]);
  };

  /** Puts a proposal aside; the board stays where it is. */
  const discardRevision = async (id: string) => {
    await useStoryJobStore.getState().markRevisionRead(id);
    setPreviewId(null);
  };

  /** Writes the changes the reader kept, and brings the board up to date. */
  const applyRevisionAnswer = async (
    answer: RevisionAnswer,
    selection: RevisionSelection,
    revision: number,
  ) => {
    if (previewId === null || chapter === undefined) return;
    const application = applyRevision(
      story,
      chapter,
      answer,
      revision,
      selection,
    );
    if (application.stale) {
      toast("error", t("story:storyboard.revisionStale"));
      return;
    }
    if (application.commands.length > 0) {
      const done = execute(
        t("story:history.reviseBoard"),
        application.commands,
        previewId,
      );
      if (done === null) return;
    }
    await useStoryJobStore.getState().markRevisionRead(previewId);
    setPreviewId(null);
    toast(
      "success",
      application.keyframes === 0
        ? t("story:storyboard.revisionSynced")
        : t("story:storyboard.revisionDone", {
            count: application.keyframes,
          }),
    );
  };

  /** Writes the whole episode again from the outline as it stands. */
  const rebuildChapter = async (chapterId: string) => {
    setSyncOpen(false);
    setPreviewId(null);
    await boardEpisodes([chapterId]);
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
  const boarded = chapterBoarded(chapter);
  const ahead = chapterOutlineAhead(chapter);
  const pending = pendingRevision(jobs, chapter.id);
  const revisionJobs = revisionRuns(jobs, chapter.id);
  const redrawable = driftedTargets.filter((target) => !drawing(target));
  // One rewrite at a time: both bulk presses ask the same text model, and a
  // second press while the first is still reading would only queue behind it.
  const bulkBusy = rewriting !== null || rewritingClips !== null;
  const previewRecord =
    previewId === null ? undefined : jobs.find((job) => job.id === previewId);

  /**
   * One bulk press's drawings, their frames rewritten first where the reader
   * asked for it. A frame whose words could not be rewritten is not drawn;
   * the toast that carries the failure says which, and why.
   */
  const drawFrames = async (
    targets: Array<{
      chapterId: string;
      actId: string;
      keyframeId: string;
      count?: number;
    }>,
  ) => {
    const waves = planKeyframeArtWaves(story, targets);
    const prepared = rewritePrompts
      ? await preparePrompts(story, "keyframeArt", waves)
      : waves;
    if (prepared.length === 0) return;
    await runArt(story.id, "keyframeArt", prepared);
  };

  /** Stops a press whose words are still being rewritten. */
  const stopFilming = () => {
    stoppedClips.current = true;
    stopRewritingClips();
  };

  /**
   * One bulk press's clips, a take at a time — and, where the reader asked
   * for it, each take's words read afresh from the board's own prompt before
   * it is filmed, since the same words tend to come back as the same film.
   *
   * Every take is an ask of its own, so its answer appends to the place it
   * was asked for; the card offers the choice when more than one came home.
   * A take that could not be started, or a place whose words could not be
   * rewritten, leaves the takes around it alone.
   */
  const filmMissing = async () => {
    const live = liveStory(story.id) ?? story;
    const targets = missingVideoTargets(live, new Set(places.keys()));
    if (targets.length === 0) return;
    const planned = planMissingVideoWaves(live, targets);
    if (planned.length === 0) return;
    stoppedClips.current = false;
    const records: string[] = [];
    for (let round = 1; round <= videoCount; round += 1) {
      if (stoppedClips.current) break;
      let waves = planned;
      if (rewriteClips) {
        waves = await prepareClips(live, planned, {
          round,
          rounds: videoCount,
        });
        if (stoppedClips.current) break;
        if (waves.length === 0) continue;
      }
      for (const wave of waves) {
        const record = await useStoryJobStore
          .getState()
          .start(story.id, wave.kind, wave.items, wave.model);
        if (record !== null) records.push(record.id);
      }
    }
    await Promise.all(
      records.map((id) => waitForJob(id).catch(() => undefined)),
    );
    if (videoCount <= 1) return;
    // What came home is read off the document rather than the records: an
    // answer the room refused, or one read in already, is not a take.
    const after = liveStory(story.id) ?? live;
    const keys = targets.flatMap((target) => {
      const place =
        target.keyframeId === undefined
          ? {
              kind: "actVideo" as const,
              chapterId: target.chapterId,
              actId: target.actId,
            }
          : {
              kind: "keyframeVideo" as const,
              chapterId: target.chapterId,
              actId: target.actId,
              keyframeId: target.keyframeId,
            };
      const slot = slotAt(after, place);
      return slot !== undefined && slot.takes.length > 1
        ? [clipChoiceKey(story.id, place)]
        : [];
    });
    useClipChoiceStore.getState().mark(keys);
  };

  /**
   * Redraws what the telling has moved past, frames first and clips after.
   *
   * The clips are planned again from the document once the frames have landed:
   * a clip is out of date because its frame is newer, so the frames that are
   * drawn now are what decide which clips this press has to film. A stop is
   * heard between waves; a wave already out finishes, since a provider does
   * not give the minutes back.
   */
  const redrawStale = async () => {
    staleStop.current = false;
    setStaleRunning(true);
    try {
      const first = liveStory(story.id) ?? story;
      const plan = planStaleRedraw(first, new Set(busyPlaces(jobs).keys()));
      const frameRecords: string[] = [];
      for (const wave of planKeyframeArtWaves(
        first,
        plan.frames.map(({ chapterId, actId, keyframeId }) => ({
          chapterId,
          actId,
          keyframeId,
        })),
      )) {
        if (staleStop.current) break;
        const record = await useStoryJobStore
          .getState()
          .start(story.id, "keyframeArt", wave.items, wave.model);
        if (record !== null) frameRecords.push(record.id);
      }
      await Promise.all(
        frameRecords.map((id) => waitForJob(id).catch(() => undefined)),
      );
      if (staleStop.current) return;

      const second = liveStory(story.id) ?? first;
      const after = planStaleRedraw(
        second,
        new Set(busyPlaces(useStoryJobStore.getState().jobs).keys()),
      );
      const clipRecords: string[] = [];
      for (const wave of planMissingVideoWaves(second, after.clips)) {
        if (staleStop.current) break;
        const record = await useStoryJobStore
          .getState()
          .start(story.id, wave.kind, wave.items, wave.model);
        if (record !== null) clipRecords.push(record.id);
      }
      await Promise.all(
        clipRecords.map((id) => waitForJob(id).catch(() => undefined)),
      );
    } finally {
      setStaleRunning(false);
    }
  };

  /** One episode's chip, as the strip shows it open or folded. */
  const chapterChip = (held: StoryChapter, at: number) => {
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
        <span className="story-hint">{t(state.key, state.values ?? {})}</span>
      </button>
    );
  };

  return (
    <div className="story-step-scroll" data-testid="story-step-storyboard-body">
      <div className="story-step-wide">
        <div className="story-step-bar">
          <p className="story-step-lead">{t("story:storyboard.lead")}</p>
          <StoryImportButton story={story} target="canvas" />
        </div>
        <div className="story-step-bar">
          {/* The board draws and films in batches like the cast does, and one
              model's queue is asked to serve the same count here: the number
              belongs to the step's band rather than to one button. */}
          <StoryModelPicks
            places={["text", "image", "video", "audio", "music"]}
            withParallel
          />
          <ReferenceLimitField story={story} />
        </div>
        <p className="story-hint" data-testid="story-board-audio-fallback">
          {t("story:voice.audioFallback")}
        </p>

        <div className="story-step-bar">
          <span className="story-hint">
            {t("story:storyboard.granularityDefault")}
          </span>
          <span
            aria-label={t("story:storyboard.granularityDefault")}
            className="story-granularity"
            role="radiogroup"
            title={t("story:storyboard.granularityDefaultHint")}
          >
            {STORY_GRANULARITY_OPTIONS.map((option) => {
              const blocked =
                option === "keyframe" &&
                pinnedByPictures &&
                story.shotGranularity !== "keyframe";
              return (
                <button
                  aria-checked={story.shotGranularity === option}
                  className={`story-choice${story.shotGranularity === option ? " is-on" : ""}`}
                  data-testid={`story-granularity-${option}`}
                  disabled={blocked}
                  key={option}
                  onClick={() => chooseGranularity(option)}
                  role="radio"
                  title={
                    blocked
                      ? t("story:storyboard.granularityPinned")
                      : undefined
                  }
                  type="button"
                >
                  {t(`story:storyboard.granularity_${option}`)}
                </button>
              );
            })}
          </span>
          <div className="story-step-actions">
            {staleTotal > 0 && (
              <button
                data-testid="story-board-redraw-stale"
                disabled={bulkBusy || staleRunning}
                onClick={() => setStaleOpen(true)}
                type="button"
              >
                {t("story:storyboard.staleRedraw", { count: staleTotal })}
              </button>
            )}
            {staleRunning && (
              <span
                className="story-hint"
                data-testid="story-board-stale-running"
              >
                <span className="story-spin" />
                {t("story:storyboard.staleRedrawRunning")}
                <button
                  className="link"
                  data-testid="story-board-stale-stop"
                  onClick={() => {
                    staleStop.current = true;
                  }}
                  type="button"
                >
                  {t("story:storyboard.staleRedrawStop")}
                </button>
              </span>
            )}
            {redrawable.length > 0 && (
              <DrawCountButton
                count={imageCount}
                disabled={bulkBusy}
                label={t("story:storyboard.redrawDrifted", {
                  count: redrawable.length,
                })}
                onCount={setImageCount}
                onRewrite={setRewritePrompts}
                onRun={() =>
                  void drawFrames(
                    redrawable.map((target) => ({
                      ...target,
                      count: imageCount,
                    })),
                  )
                }
                rewrite={rewritePrompts}
                testId="story-board-redraw-drifted"
              />
            )}
            {missingFrames.length > 0 && (
              <DrawCountButton
                count={imageCount}
                disabled={bulkBusy}
                label={t("story:storyboard.drawAllMissing", {
                  count: missingFrames.length,
                })}
                onCount={setImageCount}
                onRewrite={setRewritePrompts}
                onRun={() =>
                  void drawFrames(
                    missingFrames.map((target) => ({
                      ...target,
                      count: imageCount,
                    })),
                  )
                }
                primary
                rewrite={rewritePrompts}
                testId="story-board-draw-missing"
              />
            )}
            {rewriting !== null && (
              <span className="story-hint" data-testid="story-board-rewriting">
                <span className="story-spin" />
                {t("story:panels.rewriteProgress", { ...rewriting })}
                <button
                  className="link"
                  data-testid="story-board-rewriting-stop"
                  onClick={stopRewriting}
                  type="button"
                >
                  {t("story:panels.rewriteStop")}
                </button>
              </span>
            )}
            {missingClips.length > 0 && (
              <DrawCountButton
                count={videoCount}
                disabled={bulkBusy}
                kind="clip"
                label={t("story:storyboard.filmAllMissing", {
                  count: missingClips.length,
                })}
                max={MAX_VIDEO_TAKES_PER_ASK}
                onCount={setVideoCount}
                onRewrite={setRewriteClips}
                onRun={() => void filmMissing()}
                rewrite={rewriteClips}
                testId="story-board-film-missing"
                title={t("story:storyboard.filmAllMissingHint")}
              />
            )}
            {rewritingClips !== null && (
              <span
                className="story-hint"
                data-testid="story-board-rewriting-clips"
              >
                <span className="story-spin" />
                {t("story:panels.videoRewriteProgress", {
                  ...rewritingClips,
                })}
                <button
                  className="link"
                  data-testid="story-board-rewriting-clips-stop"
                  onClick={stopFilming}
                  type="button"
                >
                  {t("story:panels.rewriteStop")}
                </button>
              </span>
            )}
            {boarded && (
              <button
                data-testid="story-board-continuity"
                disabled={kindRunning(jobs, "continuity")}
                onClick={() => void checkContinuity([chapter.id])}
                title={t("story:storyboard.continuityHint")}
                type="button"
              >
                {t("story:storyboard.continuity")}
              </button>
            )}
            {boardedChapters.length >= 2 && (
              <button
                data-testid="story-board-continuity-all"
                disabled={kindRunning(jobs, "continuity")}
                onClick={() =>
                  void checkContinuity(boardedChapters.map((held) => held.id))
                }
                title={t("story:storyboard.continuityAllHint")}
                type="button"
              >
                {t("story:storyboard.continuityAll", {
                  count: boardedChapters.length,
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
            {!boarded && (
              <button
                data-testid="story-board-plan-acts"
                disabled={kindRunning(jobs, "actPlan")}
                onClick={() => void planActs(chapter.id)}
                title={t("story:storyboard.planActsHint")}
                type="button"
              >
                {kindRunning(jobs, "actPlan")
                  ? t("story:storyboard.planActsRunning")
                  : t("story:storyboard.planActs")}
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
                void boardEpisodes([chapter.id]);
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

        <div className="story-chapter-strip-bar">
          <button
            aria-expanded={stripOpen}
            aria-label={t(
              stripOpen
                ? "story:storyboard.hideChapters"
                : "story:storyboard.showChapters",
            )}
            className="story-strip-fold"
            data-testid="story-board-strip-fold"
            onClick={() => {
              rememberStripFold(story.id, stripOpen);
              setStripOpen(!stripOpen);
            }}
            title={t(
              stripOpen
                ? "story:storyboard.hideChapters"
                : "story:storyboard.showChapters",
            )}
            type="button"
          >
            <FoldChevron open={stripOpen} />
          </button>
          <div className="story-chapter-strip" role="tablist">
            {stripOpen
              ? story.chapters.map((held, at) => chapterChip(held, at))
              : chapterStripWindow(story.chapters.length, index).map(
                  (slot, at) =>
                    slot === "gap" ? (
                      <span
                        aria-hidden="true"
                        className="story-chapter-gap"
                        key={`gap-${at}`}
                      >
                        …
                      </span>
                    ) : (
                      chapterChip(story.chapters[slot]!, slot)
                    ),
                )}
          </div>
        </div>

        <div className="story-board-head">
          <span className="story-board-name">
            {t("story:storyboard.chapterAt", {
              number: index + 1,
              title: chapter.title,
            })}
          </span>
          <span
            className="story-hint story-board-counts"
            data-testid="story-board-counts"
          >
            {t("story:storyboard.chapterCounts", {
              acts: chapter.acts.length,
              shots: chapter.acts.reduce(
                (sum, act) => sum + act.keyframes.length,
                0,
              ),
            })}
          </span>
          <span className="story-count" data-testid="story-board-target">
            {t("story:storyboard.target", {
              duration: formatDuration(chapter.targetDurationMs),
            })}
          </span>
          <BudgetHint chapter={chapter} />
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
          {ahead && (
            <span
              className="story-outline-ahead"
              data-testid="story-board-outline-ahead"
            >
              <span className="story-hint">
                {t("story:storyboard.outlineAhead", {
                  revision: chapterRevision(chapter),
                  board: chapterBoardRevision(chapter),
                })}
              </span>
              <button
                className="link"
                data-testid="story-board-outline-update"
                onClick={() => setSyncOpen(true)}
                type="button"
              >
                {t("story:storyboard.outlineUpdate")}
              </button>
            </span>
          )}
        </div>

        {pending !== undefined && (
          <div
            className="story-board-revision"
            data-testid="story-board-revision-pending"
          >
            <span>{t("story:storyboard.revisionPending")}</span>
            <button
              className="primary"
              data-testid="story-board-revision-review"
              onClick={() => setPreviewId(pending.record.id)}
              type="button"
            >
              {t("story:storyboard.revisionReview")}
            </button>
            <button
              className="link"
              data-testid="story-board-revision-discard"
              onClick={() => void discardRevision(pending.record.id)}
              type="button"
            >
              {t("story:storyboard.revisionDiscard")}
            </button>
          </div>
        )}

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
                model={modelNameOf(models, job.model)}
                pieces={job.items}
                testId="story-board-running"
              />
            ))}
          </div>
        )}

        {revisionJobs.length > 0 && (
          <div className="story-runs">
            {revisionJobs.map((job) => (
              <RunningBar
                job={job}
                key={job.id}
                label={t("story:storyboard.revisionRunning")}
                model={modelNameOf(models, job.model)}
                pieces={job.items}
                testId="story-board-revision-running"
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
              const busy = busyIn(places, chapter.id, act);
              return (
                <Fragment key={act.id}>
                  {/*
                    An act goes where the reader points rather than only after
                    the last one: a row stands above every act — and one under
                    them all — so an episode being reworked grows at the seam
                    the new act belongs to.
                  */}
                  <li className="story-insert">
                    {/*
                      A seam between two acts is where a bridge or a join is
                      asked for as well as a new act: the two acts either side
                      are exactly the two a reader would name.
                    */}
                    <span className="story-insert-actions">
                      <button
                        data-testid={`story-act-insert-${at}`}
                        onClick={() => insertAct(at)}
                        type="button"
                      >
                        {t("story:storyboard.insertAct")}
                      </button>
                      {at > 0 &&
                        at < chapter.acts.length &&
                        chapter.acts[at - 1]?.transition === undefined &&
                        chapter.acts[at]?.transition === undefined && (
                          <>
                            <button
                              data-testid={`story-act-merge-${at}`}
                              onClick={() => mergeActsAt(story, chapter.id, at)}
                              title={t("story:storyboard.mergeActsHint")}
                              type="button"
                            >
                              {t("story:storyboard.mergeActs")}
                            </button>
                            <button
                              data-testid={`story-act-transition-${at}`}
                              onClick={() =>
                                addTransitionAt(story, chapter.id, at)
                              }
                              title={t("story:storyboard.addTransitionHint")}
                              type="button"
                            >
                              {t("story:storyboard.addTransition")}
                            </button>
                          </>
                        )}
                    </span>
                  </li>
                  {act.transition !== undefined ? (
                    <TransitionCard
                      act={act}
                      chapter={chapter}
                      index={at}
                      runs={actRuns(jobs, chapter.id, act.id)}
                      story={story}
                      videoBusy={busy.video}
                    />
                  ) : (
                    <ActCard
                      act={act}
                      busyKeyframes={busy.frames}
                      busyClips={busy.clips}
                      busyLines={busy.lines}
                      chapterId={chapter.id}
                      clipPromptDrifted={actVideoPromptDrifted(
                        story,
                        chapter.id,
                        act,
                        snapshots,
                      )}
                      driftedFrames={driftedFrames}
                      guesses={marks.get(act.id) ?? []}
                      index={at}
                      last={at === chapter.acts.length - 1}
                      musicBusy={busy.music}
                      onPlan={() => void planActs(chapter.id, act.id)}
                      runs={actRuns(jobs, chapter.id, act.id)}
                      story={story}
                      videoBusy={busy.video}
                      voiceBusy={busy.voice}
                    />
                  )}
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
            void boardEpisodes([chapter.id]);
          }}
          testId="regenerate-board"
          title={t("story:storyboard.regenerateTitle", { number: index + 1 })}
        />
      )}
      {staleOpen && (
        <ConfirmDialog
          body={[
            stale.frames.length > 0
              ? t("story:storyboard.staleRedrawFrames", {
                  count: stale.frames.length,
                  elements: staleElements,
                })
              : "",
            stale.clips.length > 0
              ? t("story:storyboard.staleRedrawClips", {
                  count: stale.clips.length,
                })
              : "",
            t("story:storyboard.staleRedrawOrder"),
          ]
            .filter((line) => line !== "")
            .join(" ")}
          confirm={t("story:storyboard.staleRedrawConfirm")}
          onCancel={() => setStaleOpen(false)}
          onConfirm={() => {
            setStaleOpen(false);
            void redrawStale();
          }}
          testId="stale-redraw"
          title={t("story:storyboard.staleRedrawTitle")}
        />
      )}
      {granularityTo !== null && (
        <ConfirmDialog
          body={t("story:storyboard.granularityBody", {
            count: videos,
            to: t(`story:storyboard.granularity_by_${granularityTo}`),
          })}
          confirm={t("story:storyboard.granularityConfirm", {
            to: t(`story:storyboard.granularity_by_${granularityTo}`),
          })}
          note={t("story:storyboard.granularityNote")}
          onCancel={() => setGranularityTo(null)}
          onConfirm={() => {
            writeGranularity(granularityTo);
            setGranularityTo(null);
          }}
          testId="change-granularity"
          title={t("story:storyboard.granularityDefaultTitle", {
            to: t(`story:storyboard.granularity_by_${granularityTo}`),
          })}
        />
      )}
      {syncOpen && (
        <OutlineSyncDialog
          chapter={chapter}
          onCancel={() => setSyncOpen(false)}
          onPatch={() => void startRevision(chapter.id)}
          onRebuild={() => void rebuildChapter(chapter.id)}
        />
      )}
      {previewRecord !== undefined && (
        <OutlineRevisionDialog
          chapter={chapter}
          key={previewRecord.id}
          onApply={(answer, selection, revision) =>
            void applyRevisionAnswer(answer, selection, revision)
          }
          onClose={() => setPreviewId(null)}
          onDiscard={() => void discardRevision(previewRecord.id)}
          onRebuild={() => void rebuildChapter(chapter.id)}
          onRetry={() => void startRevision(chapter.id)}
          record={previewRecord}
          story={story}
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
  if (
    chapter.acts.every((act) =>
      actComplete(act, actGranularity(act, granularity)),
    )
  ) {
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

/**
 * How many clips a story holds, wherever they were made, counted over the acts
 * a switch would actually touch.
 */
function countVideos(
  story: StoryDocument,
  of: (act: StoryAct) => boolean,
): number {
  return story.chapters
    .flatMap((chapter) => chapter.acts)
    .filter(of)
    .reduce(
      (sum, act) =>
        sum +
        (act.video.takes.length > 0 ? 1 : 0) +
        act.keyframes.filter((keyframe) => keyframe.video.takes.length > 0)
          .length,
      0,
    );
}

/**
 * Which of an act's shots are being drawn or filmed, and whether its own clip,
 * its lines or its score are being made — one place at a time, since one batch
 * making one of them says nothing about the others.
 */
function busyIn(
  places: Map<string, PlaceBusy>,
  chapterId: string,
  act: StoryAct,
): {
  frames: Map<string, PlaceBusy>;
  clips: Map<string, PlaceBusy>;
  lines: Map<string, PlaceBusy>;
  video: PlaceBusy | undefined;
  voice: PlaceBusy | undefined;
  music: PlaceBusy | undefined;
} {
  const frames = new Map<string, PlaceBusy>();
  const clips = new Map<string, PlaceBusy>();
  const lines = new Map<string, PlaceBusy>();
  const video = places.get(
    targetKey({ kind: "actVideo", chapterId, actId: act.id }),
  );
  const music = places.get(
    targetKey({ kind: "actMusic", chapterId, actId: act.id }),
  );
  for (const keyframe of act.keyframes) {
    for (const line of keyframe.dialogue) {
      const key = targetKey({
        kind: "lineVoice",
        chapterId,
        actId: act.id,
        keyframeId: keyframe.id,
        lineId: line.id,
      });
      const held = places.get(key);
      if (held !== undefined) lines.set(line.id, held);
    }
    const frame = places.get(
      targetKey({
        kind: "keyframe",
        chapterId,
        actId: act.id,
        keyframeId: keyframe.id,
      }),
    );
    if (frame !== undefined) frames.set(keyframe.id, frame);
    const clip = places.get(
      targetKey({
        kind: "keyframeVideo",
        chapterId,
        actId: act.id,
        keyframeId: keyframe.id,
      }),
    );
    if (clip !== undefined) clips.set(keyframe.id, clip);
  }
  // The act's voice row is at work while any of its lines is being read, and
  // while its old whole-act reading is being made: the two sit on one row.
  const voice = mergePlaces([
    ...lines.values(),
    places.get(targetKey({ kind: "actVoice", chapterId, actId: act.id })),
  ]);
  return { frames, clips, lines, video, voice, music };
}
