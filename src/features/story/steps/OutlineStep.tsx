import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { StoryJobItemDraft, StoryJobRecord } from "../../../api/story";
import {
  MAX_CHAPTERS_PER_STORY,
  MAX_ITEMS_PER_STORY_JOB,
  MAX_TOTAL_DURATION_MS,
  MIN_TOTAL_DURATION_MS,
  chapterRegenerationCost,
  chapterWritten,
  chunkWaves,
  defaultChapterCount,
  formatDuration,
  type StoryChapter,
  type StoryChapterDraft,
  type StoryDocument,
} from "../../../shared/domain";
import {
  splitSource,
  sourceHeadings,
} from "../../../shared/domain/storySource";
import { errorText } from "../../../api/client";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { useAppStore } from "../../editor/stores/appStore";
import { StoryModelPicks } from "../components/StoryModelPicks";
import { StoryImportButton } from "../components/StoryImportButton";
import { StepConfirm } from "../components/StepConfirm";
import { applyFixedOutline, readOutlineAnswer } from "../jobs/apply";
import { planOutline, storySplitChars } from "../jobs/plan";
import { readTextAsset } from "../readText";
import {
  jobProgress,
  kindJob,
  pieceRunning,
  redoChapterPart,
  retryFailed,
  useRunningJob,
  useStoryJobs,
  useStoryJobStore,
} from "../stores/storyJobStore";
import { useStoryStore } from "../stores/storyStore";
import { ResplitDialog } from "../components/ResplitDialog";
import { useField } from "../panels/useField";
import { useElapsed } from "./useElapsed";

/** How long a written ask runs before the reader is told it may be a while. */
const STORY_SLOW_MS = 90_000;

/** The synopsis length the hint asks for, in characters. */
const SYNOPSIS_COMFORT = [200, 400] as const;

/** How many of a reading's warnings are shown before the rest are folded up. */
const WARNINGS_SHOWN = 6;

function toast(kind: "info" | "error", message: string): void {
  useAppStore.getState().pushToast(kind, message);
}

function messageOf(problem: unknown): string {
  return problem instanceof Error ? problem.message : String(problem);
}

/**
 * The second step: the premise written into the chapters it is told in, or a
 * manuscript divided at its own seams and written into them one part at a time.
 *
 * Nothing is asked for without being counted first. The number of chapters is
 * the reader's, the two ways of getting them are named, and a story that
 * already has chapters is not split again without being told what that costs —
 * a chapter keeps its board as long as it stands where it stood, so the answer
 * to "what will this overwrite" is what the reader is shown.
 *
 * The answers arrive as one batch and are written into the document as one
 * step, so a reader who does not like what came back undoes the whole telling
 * rather than twelve chapters. What could not be read is not thrown away: the
 * answer stays on the record, is shown as it came, and can be repaired by hand
 * and applied.
 */
export function OutlineStep({ story }: { story: StoryDocument }) {
  const { t } = useTranslation();
  const brief = story.brief;
  const sourceId = brief.sourceAssetId;
  const jobs = useStoryJobs(story.id);
  const running = useRunningJob(story.id);
  // The step's own ask, which is what its buttons wait on: a batch drawing
  // pictures for the boards is not a chapter being written, and it does not
  // hold the table back.
  const writing = kindJob(jobs, "outline");
  const failure = useStoryJobStore((state) => state.error);
  const elapsed = useElapsed(running?.createdAt);
  const [mode, setMode] = useState<"expand" | "split">(
    brief.sourceSplit === true && sourceId !== undefined ? "split" : "expand",
  );
  const [chapters, setChapters] = useState(() =>
    defaultChapterCount(brief.totalDurationMs, brief.chapterMs),
  );
  const [headings, setHeadings] = useState(0);
  const [manuscript, setManuscript] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [waves, setWaves] = useState<StoryJobItemDraft[][]>([]);
  const [totalWaves, setTotalWaves] = useState(0);
  const [asking, setAsking] = useState(false);
  // A batch is being handed over, whether for the first part or a later one.
  const startingBatch = useStoryJobStore((state) => state.starting);
  const starting = useRef(false);

  const wanted = clampChapters(chapters);
  const cost = chapterRegenerationCost(story, wanted);
  const spoken = story.chapters.some(chapterWritten);
  const drawn = story.chapters.some((chapter) => chapter.acts.length > 0);

  /** The manuscript, read once for this telling and kept for the session. */
  const needText = async (): Promise<string | null> => {
    if (sourceId === undefined) return null;
    if (manuscript !== null) return manuscript;
    setReading(true);
    try {
      const text = await readTextAsset(sourceId);
      setManuscript(text);
      return text;
    } catch (problem) {
      toast("error", messageOf(problem));
      return null;
    } finally {
      setReading(false);
    }
  };

  // A manuscript that writes its own chapters says how many the telling has:
  // the count it is cut into is offered as the count it already is.
  useEffect(() => {
    if (mode !== "split" || sourceId === undefined || headings > 0) return;
    let live = true;
    void readTextAsset(sourceId)
      .then((text) => {
        if (!live) return;
        setManuscript(text);
        const found = sourceHeadings(text);
        if (found === 0) return;
        setHeadings(found);
        setChapters(Math.min(MAX_CHAPTERS_PER_STORY, found));
      })
      .catch((problem: unknown) => {
        if (live) toast("error", messageOf(problem));
      });
    return () => {
      live = false;
    };
  }, [mode, sourceId, headings]);

  // A telling longer than one batch is taken in waves, the next one beginning
  // when the one before it is over rather than when the reader presses again —
  // and not while a batch is still being handed over, nor while the table it
  // writes into is still being written.
  useEffect(() => {
    if (
      starting.current ||
      startingBatch ||
      writing !== null ||
      waves.length === 0
    )
      return;
    const next = waves[0];
    if (next === undefined) return;
    starting.current = true;
    void useStoryJobStore
      .getState()
      .start(story.id, "outline", next)
      .then((record) => {
        setWaves((held) => (record === null ? [] : held.slice(1)));
      })
      .finally(() => {
        starting.current = false;
      });
  }, [writing, waves, story.id, startingBatch]);

  const begin = async (count: number) => {
    setAsking(false);
    if (mode === "expand") {
      setWaves([]);
      setTotalWaves(0);
      await useStoryJobStore
        .getState()
        .start(
          story.id,
          "outline",
          planOutline(story, { mode: "expand", chapters: count }),
        );
      return;
    }
    const text = await needText();
    if (text === null) return;
    const chunks = splitSource(text, {
      targetChapters: count,
      maxChars: storySplitChars(),
    });
    const items = planOutline(story, {
      mode: "split",
      chapters: count,
      chunks,
    });
    const cut = chunkWaves(items, MAX_ITEMS_PER_STORY_JOB);
    setTotalWaves(cut.length);
    setWaves(cut.slice(1));
    const first = cut[0];
    if (first === undefined) return;
    const record = await useStoryJobStore
      .getState()
      .start(story.id, "outline", first);
    if (record === null) {
      setWaves([]);
      return;
    }
    if (brief.sourceSplit !== true) {
      execute(t("story:history.brief"), [
        {
          type: "updateStoryBrief",
          storyId: story.id,
          patch: { sourceSplit: true },
        },
      ]);
    }
  };

  const start = () => {
    const count = clampChapters(chapters);
    if (story.chapters.length > 0 && (spoken || drawn)) {
      setAsking(true);
      return;
    }
    void begin(count);
  };

  const answers = newestAnswers(jobs);
  const unreadable =
    story.chapters.length === 0 &&
    answers !== undefined &&
    answers.reads.every((read) => read.draft === undefined) &&
    writing === null;

  return (
    <div className="story-step-scroll" data-testid="story-step-outline-body">
      <div className="story-step-wide">
        <div className="story-step-bar">
          <p className="story-step-lead">{t("story:outline.lead")}</p>
          <StoryImportButton story={story} target="canvas" />
        </div>
        <div className="story-step-bar">
          <StoryModelPicks places={["text"]} />
          <div className="story-outline-count">
            <span className="story-field-label">
              {t("story:outline.chapters")}
            </span>
            <button
              aria-label={t("story:outline.fewer")}
              className="story-step-count"
              onClick={() => setChapters(clampChapters(wanted - 1))}
              type="button"
            >
              −
            </button>
            <input
              aria-label={t("story:outline.chapters")}
              className="story-outline-chapters"
              data-testid="story-outline-chapters"
              max={MAX_CHAPTERS_PER_STORY}
              min={1}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) setChapters(clampChapters(value));
              }}
              type="number"
              value={wanted}
            />
            <button
              aria-label={t("story:outline.more")}
              className="story-step-count"
              onClick={() => setChapters(clampChapters(wanted + 1))}
              type="button"
            >
              +
            </button>
          </div>
        </div>

        <p className="story-hint" data-testid="story-outline-chapters-hint">
          {headings > 0
            ? t("story:outline.detected", { count: headings })
            : t("story:outline.chaptersHint", {
                minutes: Math.round(
                  Math.max(1, brief.totalDurationMs / wanted) / 60_000,
                ),
                duration: formatDuration(brief.totalDurationMs),
              })}
        </p>

        <div className="story-step-bar">
          <div
            aria-label={t("story:outline.source")}
            className="story-chips"
            role="radiogroup"
          >
            <button
              aria-checked={mode === "expand"}
              className={`story-choice${mode === "expand" ? " is-on" : ""}`}
              data-testid="story-outline-mode-expand"
              onClick={() => setMode("expand")}
              role="radio"
              type="button"
            >
              {t("story:outline.modeExpand")}
            </button>
            <button
              aria-checked={mode === "split"}
              className={`story-choice${mode === "split" ? " is-on" : ""}`}
              data-testid="story-outline-mode-split"
              disabled={sourceId === undefined}
              onClick={() => setMode("split")}
              role="radio"
              title={
                sourceId === undefined
                  ? t("story:outline.modeSplitLocked")
                  : undefined
              }
              type="button"
            >
              {t("story:outline.modeSplit")}
            </button>
          </div>

          <div className="story-step-actions">
            <span className="story-hint" data-testid="story-outline-will-ask">
              {t("story:outline.willAsk", { count: wanted })}
            </span>
            {totalWaves > 1 && (running !== null || waves.length > 0) && (
              <span className="story-hint" data-testid="story-outline-wave">
                {t("story:outline.wave", {
                  at: Math.max(1, totalWaves - waves.length),
                  of: totalWaves,
                })}
              </span>
            )}
            <button
              className="primary"
              data-testid="story-outline-start"
              disabled={writing !== null || reading}
              onClick={start}
              type="button"
            >
              {writing !== null
                ? t("story:jobs.busy", jobProgress(writing))
                : reading
                  ? t("story:outline.reading")
                  : story.chapters.length > 0
                    ? t("story:outline.resplit")
                    : t("story:outline.start")}
            </button>
            <StepConfirm step="outline" story={story} />
          </div>
        </div>

        {failure !== null && (
          <p className="story-hint" data-testid="story-outline-error">
            {failure}
          </p>
        )}

        {running !== null && (
          <div
            className="story-running"
            data-testid="story-outline-running"
            role="status"
          >
            <span>
              {t(
                running.kind === "outline"
                  ? "story:outline.writing"
                  : "story:jobs.generating",
              )}{" "}
              · {formatDuration(elapsed)}
            </span>
            {elapsed >= STORY_SLOW_MS && (
              <span className="story-hint">{t("story:outline.slow")}</span>
            )}
            <button
              className="link"
              data-testid="story-outline-cancel"
              onClick={() =>
                void useStoryJobStore.getState().cancel(running.id)
              }
              type="button"
            >
              {t("story:outline.cancel")}
            </button>
          </div>
        )}

        {unreadable ? (
          <div
            className="clip-empty clip-empty-first"
            data-testid="story-outline-empty"
          >
            <p>{t("story:outline.unreadable")}</p>
            <div className="story-step-actions">
              <button
                className="link"
                data-testid="story-outline-again"
                onClick={() => void retryFailed(story, answers.job)}
                type="button"
              >
                {t("story:outline.again")}
              </button>
            </div>
          </div>
        ) : (
          <ol className="story-chapters">
            {story.chapters.map((chapter, index) => (
              <ChapterCard
                chapter={chapter}
                index={index}
                key={chapter.id}
                offerRedo={mode === "split" && sourceId !== undefined}
                redoBusy={pieceRunning(jobs, `outline:${index + 1}`)}
                story={story}
              />
            ))}
          </ol>
        )}

        {answers !== undefined && (
          <AnswersPanel job={answers.job} reads={answers.reads} story={story} />
        )}
      </div>

      {asking && (
        <ResplitDialog
          cost={cost}
          onCancel={() => setAsking(false)}
          onConfirm={() => void begin(wanted)}
        />
      )}
    </div>
  );
}

function clampChapters(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_CHAPTERS_PER_STORY, Math.max(1, Math.round(value)));
}

/** One episode, as the reader writes it. */
function ChapterCard({
  story,
  chapter,
  index,
  offerRedo,
  redoBusy,
}: {
  story: StoryDocument;
  chapter: StoryChapter;
  index: number;
  offerRedo: boolean;
  /** Whether this chapter's own ask for a new telling of it is out just now. */
  redoBusy: boolean;
}) {
  const { t } = useTranslation();
  const write = (patch: Partial<StoryChapter>) => {
    const chapters = story.chapters.map((held, at) =>
      at === index ? { ...held, ...patch } : held,
    );
    execute(i18n.t("story:history.chapters"), [
      { type: "setStoryChapters", storyId: story.id, chapters },
    ]);
  };
  const title = useField(chapter.title, (value) => {
    const trimmed = value.trim();
    if (trimmed !== "") write({ title: trimmed });
  });
  const synopsis = useField(chapter.synopsis, (value) => {
    write({ synopsis: value });
  });
  const minutes = Math.round((chapter.targetDurationMs / 60_000) * 10) / 10;

  return (
    <li className="story-chapter" data-testid={`story-chapter-${index}`}>
      <div className="story-chapter-head">
        <span className="story-chapter-index">{index + 1}</span>
        <input
          aria-label={t("story:outline.title")}
          className="story-chapter-title"
          data-testid={`story-chapter-title-${index}`}
          maxLength={60}
          onBlur={title.commit}
          onChange={(event) => title.set(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              title.commit();
            }
          }}
          value={title.value}
        />
        {chapter.acts.length > 0 && (
          <button
            className="story-chapter-acts"
            data-testid={`story-chapter-acts-${index}`}
            onClick={() => {
              useStoryStore.getState().openChapter(chapter.id);
              useStoryStore.getState().goStep("storyboard");
            }}
            type="button"
          >
            {t("story:outline.acts", { count: chapter.acts.length })}
          </button>
        )}
      </div>
      <textarea
        aria-label={t("story:outline.synopsis")}
        className="story-chapter-synopsis"
        data-testid={`story-chapter-synopsis-${index}`}
        maxLength={2000}
        onBlur={synopsis.commit}
        onChange={(event) => synopsis.set(event.target.value)}
        rows={3}
        value={synopsis.value}
      />
      <div className="story-chapter-foot">
        <span
          className="story-count"
          data-testid={`story-chapter-count-${index}`}
        >
          {t("story:outline.synopsisHint", {
            used: synopsis.value.length,
            low: SYNOPSIS_COMFORT[0],
            high: SYNOPSIS_COMFORT[1],
          })}
        </span>
        <div className="story-stepper">
          <button
            aria-label={t("story:outline.shorter")}
            onClick={() =>
              write({ targetDurationMs: stepDuration(chapter, -1) })
            }
            type="button"
          >
            −
          </button>
          <input
            aria-label={t("story:outline.duration")}
            data-testid={`story-chapter-duration-${index}`}
            max={MAX_TOTAL_DURATION_MS / 60_000}
            min={MIN_TOTAL_DURATION_MS / 60_000}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value)) {
                write({ targetDurationMs: clampDuration(value * 60_000) });
              }
            }}
            step={0.5}
            type="number"
            value={minutes}
          />
          <span className="story-stepper-unit">
            {t("story:outline.minutes")}
          </span>
          <button
            aria-label={t("story:outline.longer")}
            onClick={() =>
              write({ targetDurationMs: stepDuration(chapter, 1) })
            }
            type="button"
          >
            +
          </button>
        </div>
        {chapter.acts.length > 0 && (
          <span className="story-hint">{t("story:outline.durationBoard")}</span>
        )}
        {offerRedo && (
          <span className="story-chapter-actions">
            <button
              className="link"
              data-testid={`story-chapter-redo-${index}`}
              disabled={redoBusy}
              onClick={() => void redoChapterPart(story, index)}
              type="button"
            >
              {t("story:outline.redo")}
            </button>
          </span>
        )}
      </div>
    </li>
  );
}

function stepDuration(chapter: StoryChapter, by: number): number {
  return clampDuration(chapter.targetDurationMs + by * 60_000);
}

function clampDuration(ms: number): number {
  return Math.min(MAX_TOTAL_DURATION_MS, Math.max(MIN_TOTAL_DURATION_MS, ms));
}

// -----------------------------------------------------------------------------
// The answers, as the reader reads them
// -----------------------------------------------------------------------------

interface AnswerRead {
  item: StoryJobRecord["items"][number];
  warnings: string[];
  draft?: StoryChapterDraft;
  error?: string;
}

/** The newest batch of this story that has answers in it, read back. */
function newestAnswers(jobs: StoryJobRecord[]):
  | {
      job: StoryJobRecord;
      reads: AnswerRead[];
    }
  | undefined {
  const job = jobs.find(
    (held) =>
      held.kind === "outline" &&
      held.items.some((item) => item.text !== undefined),
  );
  if (job === undefined) return undefined;
  return {
    job,
    reads: job.items
      .filter((item) => item.text !== undefined)
      .map((item) => {
        const read = readOutlineAnswer(item.text ?? "");
        return {
          item,
          warnings: read.warnings,
          draft: read.drafts?.[0],
          error: read.error,
        };
      }),
  };
}

/**
 * What the batch said about itself: what the reading had to warn about, and
 * the answers exactly as they arrived.
 *
 * An answer nobody could read is not thrown away — it is the only thing the
 * reader has to repair — so it is shown whole, can be copied out, and can be
 * rewritten in place and applied, judged by the same reading as before.
 */
function AnswersPanel({
  job,
  reads,
  story,
}: {
  job: StoryJobRecord;
  reads: AnswerRead[];
  story: StoryDocument;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [allWarnings, setAllWarnings] = useState(false);
  const [at, setAt] = useState(0);
  const [fixing, setFixing] = useState(false);
  const [fixed, setFixed] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = reads[Math.min(at, reads.length - 1)];
  const warnings = reads.flatMap((read) =>
    read.warnings.map((warning) => `${read.item.id}: ${warning}`),
  );
  const shown = allWarnings ? warnings : warnings.slice(0, WARNINGS_SHOWN);

  const applyFix = () => {
    const failure = applyFixedOutline(
      story,
      chosen?.item.id ?? "outline",
      fixed,
    );
    if (failure !== undefined) {
      setProblem(failure);
      return;
    }
    setProblem(null);
    setFixing(false);
  };

  return (
    <div className="story-answers">
      {warnings.length > 0 && (
        <div
          className="story-warnings"
          data-testid="story-outline-warnings"
          role="status"
        >
          <ul>
            {shown.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          {warnings.length > WARNINGS_SHOWN && (
            <button
              className="link"
              data-testid="story-outline-warnings-more"
              onClick={() => setAllWarnings(!allWarnings)}
              type="button"
            >
              {allWarnings
                ? t("story:outline.fewerWarnings")
                : t("story:outline.moreWarnings", {
                    count: warnings.length - WARNINGS_SHOWN,
                  })}
            </button>
          )}
        </div>
      )}

      <button
        className="link"
        data-testid="story-outline-answer-toggle"
        onClick={() => setOpen(!open)}
        type="button"
      >
        {open ? t("story:outline.hideAnswer") : t("story:outline.showAnswer")}
      </button>

      {open && chosen !== undefined && (
        <div className="story-answer" data-testid="story-outline-answer">
          {reads.length > 1 && (
            <div className="story-answer-tabs">
              {reads.map((read, index) => (
                <button
                  aria-pressed={index === at}
                  className={`story-choice${read.draft === undefined ? " is-failed" : ""}`}
                  data-testid={`story-outline-answer-${index}`}
                  key={read.item.id}
                  onClick={() => {
                    setAt(index);
                    setFixed("");
                    setProblem(null);
                  }}
                  type="button"
                >
                  {t("story:outline.part", { number: index + 1 })}
                </button>
              ))}
            </div>
          )}
          {chosen.error !== undefined && (
            <p
              className="story-answer-error"
              data-testid="story-outline-answer-error"
            >
              {t("story:parse.failed")} — {chosen.error}
            </p>
          )}
          <pre
            className="dialog-answer"
            data-testid="story-outline-answer-text"
          >
            {chosen.item.text}
          </pre>
          <div className="story-step-actions">
            <button
              className="link"
              data-testid="story-outline-answer-copy"
              onClick={() => {
                // A copy that was refused says so: "nothing happened" is what
                // a reader would otherwise be left with.
                void navigator.clipboard
                  ?.writeText(chosen.item.text ?? "")
                  .catch((problem: unknown) => {
                    toast(
                      "error",
                      t("story:outline.copyFailed", {
                        reason: errorText(problem).message,
                      }),
                    );
                  });
              }}
              type="button"
            >
              {t("story:outline.copy")}
            </button>
            <button
              className="link"
              data-testid="story-outline-answer-fix"
              onClick={() => {
                setFixing(!fixing);
                setFixed(chosen.item.text ?? "");
                setProblem(null);
              }}
              type="button"
            >
              {t("story:outline.fix")}
            </button>
          </div>
          {fixing && (
            <div className="story-answer-fix">
              <textarea
                aria-label={t("story:outline.fixLabel", { id: chosen.item.id })}
                data-testid="story-outline-answer-edit"
                onChange={(event) => setFixed(event.target.value)}
                rows={8}
                value={fixed}
              />
              {problem !== null && (
                <p
                  className="story-answer-error"
                  data-testid="story-outline-answer-problem"
                >
                  {problem}
                </p>
              )}
              <div className="story-step-actions">
                <button
                  className="primary"
                  data-testid="story-outline-answer-apply"
                  onClick={applyFix}
                  type="button"
                >
                  {t("story:outline.apply")}
                </button>
              </div>
            </div>
          )}
          <p className="story-hint">
            {t("story:outline.answerFrom", { model: job.model })}
          </p>
        </div>
      )}
    </div>
  );
}
