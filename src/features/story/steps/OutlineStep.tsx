import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { assetsApi } from "../../../api";
import {
  MAX_CHAPTERS_PER_STORY,
  MAX_TOTAL_DURATION_MS,
  MIN_TOTAL_DURATION_MS,
  chapterRegenerationCost,
  chapterWritten,
  createChapter,
  defaultChapterCount,
  formatDuration,
  mergeChaptersAt,
  type StoryChapter,
  type StoryDocument,
} from "../../../shared/domain";
import type { DocumentCommand } from "../../../shared/domain/types";
import { sourceHeadings } from "../../../shared/domain/storySource";
import { execute } from "../../editor/commands/execute";
import { useAppStore } from "../../editor/stores/appStore";
import { saveTrouble, useProjectStore } from "../../editor/stores/projectStore";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StoryModelPicks } from "../components/StoryModelPicks";
import { StoryImportButton } from "../components/StoryImportButton";
import { StepConfirm } from "../components/StepConfirm";
import { planOutline, storySplitChars } from "../jobs/plan";
import { SplitCancelled, runManuscriptSplit } from "../jobs/split";
import { readTextAsset } from "../readText";
import {
  jobProgress,
  kindJob,
  pieceRunning,
  redoGeneratedChapter,
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

function toast(kind: "info" | "success" | "error", message: string): void {
  useAppStore.getState().pushToast(kind, message);
}

function messageOf(problem: unknown): string {
  return problem instanceof Error ? problem.message : String(problem);
}

/**
 * The second step: the premise written into the chapters it is told in, or a
 * manuscript whose own chapters are cut out of it.
 *
 * Both paths leave the words of a chapter in the reader's hands. The premise
 * is asked for as chapters, and any one of them can be written again. A
 * manuscript is not asked for at all: the model is asked where its chapters
 * begin, the text between those places becomes each chapter's own words, and
 * the manuscript itself is released once it has been cut — every chapter can
 * be edited, inserted around, or removed without a file behind it.
 *
 * Nothing is asked for without being counted first, and a story that already
 * has chapters is not split again without being told what that costs — a
 * chapter keeps its board as long as it stands where it stood.
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
    brief.sourceSplit === true ? "split" : "expand",
  );
  const [chapters, setChapters] = useState(() =>
    defaultChapterCount(brief.totalDurationMs, brief.chapterMs),
  );
  const [headings, setHeadings] = useState(0);
  const [manuscript, setManuscript] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [asking, setAsking] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [splitPart, setSplitPart] = useState(0);
  const [splitFound, setSplitFound] = useState(0);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);

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

  const begin = async (count: number) => {
    setAsking(false);
    setSplitError(null);
    if (mode === "expand") {
      await useStoryJobStore
        .getState()
        .start(story.id, "outline", planOutline(story, { chapters: count }));
      return;
    }
    const assetId = sourceId;
    if (assetId === undefined) {
      setSplitError(t("story:outline.splitNoSource"));
      return;
    }
    const text = await needText();
    if (text === null) return;
    setSplitting(true);
    setSplitPart(1);
    setSplitFound(0);
    try {
      const drafts = await runManuscriptSplit(story, text, {
        chapters: count,
        budget: storySplitChars(),
        onProgress: ({ part, chapters: found }) => {
          setSplitPart(part);
          setSplitFound(found);
        },
      });
      // The cut can take several batches and minutes: what it is written onto
      // is the story as it stands now, not as it stood when the button was
      // pressed.
      const current =
        useProjectStore
          .getState()
          .moka?.stories?.find((held) => held.id === story.id) ?? story;
      const table = mergeChaptersAt(
        current.chapters,
        drafts.map((draft, at) => ({ at, draft })),
        true,
      );
      // The chapters now hold the manuscript's words. The brief lets the file
      // go at the same moment: it is no longer what any chapter is read from,
      // and keeping a stale reference would keep the file itself.
      const patch: {
        sourceSplit?: boolean;
        sourceAssetId: null;
        sourceName: null;
      } = { sourceAssetId: null, sourceName: null };
      if (current.brief.sourceSplit !== true) patch.sourceSplit = true;
      const commands: DocumentCommand[] = [
        { type: "updateStoryBrief", storyId: story.id, patch },
        { type: "setStoryChapters", storyId: story.id, chapters: table },
      ];
      const done = execute(t("story:history.apply.outline"), commands);
      if (done === null) {
        setSplitError(t("story:page.saveConflict"));
        return;
      }
      toast("success", t("story:outline.splitDone", { count: drafts.length }));
      // The file is removed only after the document that no longer points at
      // it has landed: the server refuses to delete an asset still in use.
      await useProjectStore.getState().flush();
      const after = useProjectStore.getState();
      if (after.pending.length > 0 || after.saveStatus !== "saved") {
        toast(
          "error",
          t("story:outline.sourceKeepFailed", {
            reason: saveTrouble().message,
          }),
        );
        return;
      }
      try {
        const removed = await assetsApi.remove(assetId);
        useProjectStore.getState().removeAssetEntry(assetId, removed);
        setManuscript(null);
      } catch (problem) {
        toast(
          "error",
          t("story:outline.sourceKeepFailed", {
            reason: messageOf(problem),
          }),
        );
      }
    } catch (problem) {
      if (problem instanceof SplitCancelled) return;
      const reason = messageOf(problem);
      setSplitError(reason);
      toast("error", reason);
    } finally {
      setSplitting(false);
      setSplitPart(0);
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

  /** One empty chapter after the one at `at`, with the episode length to hand. */
  const insertAfter = (at: number) => {
    if (story.chapters.length >= MAX_CHAPTERS_PER_STORY) {
      toast(
        "info",
        t("story:outline.chapterLimit", { max: MAX_CHAPTERS_PER_STORY }),
      );
      return;
    }
    const before = story.chapters[at];
    const chapter = {
      ...createChapter(""),
      targetDurationMs: clampDuration(
        before !== undefined && before.targetDurationMs > 0
          ? before.targetDurationMs
          : story.brief.chapterMs,
      ),
    };
    const chapters = [
      ...story.chapters.slice(0, at + 1),
      chapter,
      ...story.chapters.slice(at + 1),
    ];
    execute(t("story:history.chapters"), [
      { type: "setStoryChapters", storyId: story.id, chapters },
    ]);
  };

  /** The chapter the reader agreed to delete, taken out of the table. */
  const dropChapter = () => {
    if (deleting === null) return;
    const removed = story.chapters[deleting];
    const chapters = story.chapters.filter((_, at) => at !== deleting);
    const done = execute(t("story:history.chapters"), [
      { type: "setStoryChapters", storyId: story.id, chapters },
    ]);
    if (done !== null && removed !== undefined) {
      if (useStoryStore.getState().openChapterId === removed.id) {
        useStoryStore.getState().openChapter(null);
      }
    }
    setDeleting(null);
  };

  const busy = writing !== null || reading || splitting;

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
          {headings > 0 && sourceId !== undefined
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
            {splitting && (
              <span
                className="story-hint"
                data-testid="story-outline-splitting"
              >
                {t("story:outline.splitting", {
                  part: splitPart,
                  found: splitFound,
                })}
              </span>
            )}
            <button
              className="primary"
              data-testid="story-outline-start"
              disabled={busy || (mode === "split" && sourceId === undefined)}
              onClick={start}
              type="button"
            >
              {writing !== null
                ? t("story:jobs.busy", jobProgress(writing))
                : reading
                  ? t("story:outline.reading")
                  : splitting
                    ? t("story:outline.splittingButton", { part: splitPart })
                    : story.chapters.length > 0
                      ? t("story:outline.resplit")
                      : mode === "split"
                        ? t("story:outline.startSplit")
                        : t("story:outline.start")}
            </button>
            <StepConfirm step="outline" story={story} />
          </div>
        </div>

        {mode === "split" &&
          sourceId === undefined &&
          story.chapters.length > 0 && (
            <p
              className="story-hint"
              data-testid="story-outline-source-released"
            >
              {t("story:outline.sourceReleased")}
            </p>
          )}

        {(failure !== null || splitError !== null) && (
          <p className="story-hint" data-testid="story-outline-error">
            {splitError ?? failure}
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
                running.kind !== "outline"
                  ? "story:jobs.generating"
                  : mode === "split"
                    ? "story:outline.cutting"
                    : "story:outline.writing",
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

        <ol className="story-chapters">
          {story.chapters.map((chapter, index) => (
            <ChapterCard
              chapter={chapter}
              index={index}
              key={chapter.id}
              offerRedo={mode === "expand"}
              onDelete={() => setDeleting(index)}
              onInsert={() => insertAfter(index)}
              redoBusy={pieceRunning(jobs, `outline:rewrite:${index + 1}`)}
              story={story}
            />
          ))}
        </ol>
      </div>

      {asking && (
        <ResplitDialog
          cost={cost}
          onCancel={() => setAsking(false)}
          onConfirm={() => void begin(wanted)}
        />
      )}

      {deleting !== null && story.chapters[deleting] !== undefined && (
        <ConfirmDialog
          body={t("story:outline.deleteBody", {
            number: deleting + 1,
            title:
              story.chapters[deleting].title.trim() !== ""
                ? story.chapters[deleting].title
                : t("story:outline.untitled", { number: deleting + 1 }),
          })}
          confirm={t("story:outline.deleteConfirm")}
          note={
            (story.chapters[deleting].acts.length ?? 0) > 0
              ? t("story:outline.deleteActs", {
                  acts: story.chapters[deleting].acts.length,
                })
              : undefined
          }
          onCancel={() => setDeleting(null)}
          onConfirm={dropChapter}
          testId="delete-chapter"
          title={t("story:outline.deleteTitle")}
        />
      )}
    </div>
  );
}

function clampChapters(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_CHAPTERS_PER_STORY, Math.max(1, Math.round(value)));
}

/** One episode, as the reader writes it or as the manuscript wrote it. */
function ChapterCard({
  story,
  chapter,
  index,
  offerRedo,
  redoBusy,
  onInsert,
  onDelete,
}: {
  story: StoryDocument;
  chapter: StoryChapter;
  index: number;
  /** Whether this chapter was written from a premise and can be written again. */
  offerRedo: boolean;
  /** Whether this chapter's own ask for a new telling of it is out just now. */
  redoBusy: boolean;
  /** Adds an empty chapter after this one. */
  onInsert: () => void;
  /** Asks to take this chapter out of the story. */
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const write = (patch: Partial<StoryChapter>) => {
    const chapters = story.chapters.map((held, at) =>
      at === index ? { ...held, ...patch } : held,
    );
    execute(t("story:history.chapters"), [
      { type: "setStoryChapters", storyId: story.id, chapters },
    ]);
  };
  const title = useField(chapter.title, (value) => {
    const trimmed = value.trim();
    if (trimmed !== "") write({ title: trimmed });
  });
  // A chapter of a manuscript is its cut text; a chapter written from the
  // premise is its synopsis. Both are the same field and both are editable.
  const manuscriptChapter = story.brief.sourceSplit === true;
  const content = useField(chapter.synopsis, (value) => {
    if (value === chapter.synopsis) return;
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
          placeholder={t("story:outline.untitled", { number: index + 1 })}
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
      {manuscriptChapter ? (
        <textarea
          aria-label={t("story:outline.chapterSource")}
          className="story-chapter-synopsis"
          data-testid={`story-chapter-source-${index}`}
          onBlur={content.commit}
          onChange={(event) => content.set(event.target.value)}
          rows={6}
          value={content.value}
        />
      ) : (
        <textarea
          aria-label={t("story:outline.synopsis")}
          className="story-chapter-synopsis"
          data-testid={`story-chapter-synopsis-${index}`}
          maxLength={2000}
          onBlur={content.commit}
          onChange={(event) => content.set(event.target.value)}
          rows={3}
          value={content.value}
        />
      )}
      <div className="story-chapter-foot">
        <span
          className="story-count"
          data-testid={`story-chapter-count-${index}`}
        >
          {manuscriptChapter
            ? t("story:outline.sourceHint", {
                count: Array.from(content.value).length,
              })
            : t("story:outline.synopsisHint", {
                used: content.value.length,
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
        <span className="story-chapter-actions">
          {offerRedo && (
            <button
              className="link"
              data-testid={`story-chapter-redo-${index}`}
              disabled={redoBusy}
              onClick={() => void redoGeneratedChapter(story, index)}
              type="button"
            >
              {t("story:outline.redo")}
            </button>
          )}
          <button
            className="link"
            data-testid={`story-chapter-insert-${index}`}
            disabled={story.chapters.length >= MAX_CHAPTERS_PER_STORY}
            onClick={onInsert}
            type="button"
          >
            {t("story:outline.insertChapter")}
          </button>
          <button
            className="link"
            data-testid={`story-chapter-delete-${index}`}
            onClick={onDelete}
            type="button"
          >
            {t("story:outline.deleteChapter")}
          </button>
        </span>
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
