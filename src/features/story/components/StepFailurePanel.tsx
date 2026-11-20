import { useEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { StoryJobItem } from "../../../api/story";
import { failureText } from "../../../shared/i18n/problems";
import { i18n } from "../../../shared/i18n";
import type { StoryDocument, StoryStep } from "../../../shared/domain";
import { failurePieceLabel } from "../jobs/failureLabel";
import { relativeTime } from "../relativeTime";
import {
  retryFailed,
  useStoryStepFailureDetail,
  useStoryJobStore,
} from "../stores/storyJobStore";

/** Where the badge was when it was pressed, in viewport terms. */
export interface FailureAnchor {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

/**
 * The failures a step's red count stands on, and the reader's answer to them.
 *
 * A count alone says a step is short of something without saying what or why,
 * and a toast about it is a moment rather than a place. The panel keeps both:
 * every piece that did not come back, the reason each one gave, and one button
 * per piece to stop counting it — leaving the record, the story and the
 * history untouched. A failure put aside is still there to be restored while
 * the panel is open, and asking the whole batch again is offered beside it.
 */
export function StepFailurePanel({
  anchor,
  onClose,
  step,
  story,
}: {
  anchor: FailureAnchor;
  onClose: () => void;
  step: StoryStep;
  story: StoryDocument;
}) {
  const { t, i18n: translator } = useTranslation();
  const detail = useStoryStepFailureDetail(story.id, step);
  const ignoreFailure = useStoryJobStore((state) => state.ignoreFailure);
  const restoreFailure = useStoryJobStore((state) => state.restoreFailure);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const away = (event: PointerEvent) => {
      const element = panel.current;
      const target = event.target;
      if (element === null || !(target instanceof Node)) return;
      if (element.contains(target)) return;
      // A badge is the panel's own door, and pressing one says which step it
      // opens. Closing here would race that press and leave nothing open.
      if (
        target instanceof Element &&
        target.closest(".story-step-failed") !== null
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", away);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", away);
    };
  }, [onClose]);

  // A batch that left the room's list, or whose pieces came back after all,
  // has nothing left for the panel to say.
  useEffect(() => {
    if (detail === null) onClose();
  }, [detail, onClose]);

  if (detail === null) return null;

  const { job } = detail;
  const failedAll = job.items.filter((item) => item.status === "failed");
  const split = failedAll.some((item) => item.id.startsWith("outline:split:"));
  const canRetry = !split && failedAll.some((item) => item.retryable !== false);
  const when = relativeTime(
    job.createdAt,
    new Date(),
    translator.resolvedLanguage ?? i18n.resolvedLanguage ?? "en",
  );

  return createPortal(
    <div
      aria-labelledby={`story-step-failures-title-${step}`}
      className="story-step-failures"
      data-testid={`story-step-failures-${step}`}
      ref={panel}
      role="dialog"
      style={place(anchor)}
    >
      <header className="story-step-failures-head">
        <div>
          <h2 id={`story-step-failures-title-${step}`}>
            {t("story:jobs.failureTitle", {
              step: t(`story:step.${step}`),
              when,
            })}
          </h2>
          <p className="story-step-failures-count">
            {detail.failed.length > 0
              ? t("story:jobs.failureCount", {
                  failed: detail.failed.length,
                  total: job.items.length,
                })
              : t("story:jobs.failureAllIgnored")}
          </p>
        </div>
        <button
          aria-label={t("story:jobs.failureClose")}
          autoFocus
          className="story-step-failures-close"
          data-testid={`story-step-failures-close-${step}`}
          onClick={onClose}
          type="button"
        >
          ✕
        </button>
      </header>

      {detail.failed.length > 0 && (
        <ul className="story-step-failures-list">
          {detail.failed.map((item, index) => (
            <FailureRow
              action={t("story:jobs.failureIgnore")}
              item={item}
              key={item.id}
              onAction={() => ignoreFailure(job.id, item.id)}
              story={story}
              testId={`story-step-failure-${step}-${index}`}
            />
          ))}
        </ul>
      )}

      {detail.putAside.length > 0 && (
        <div className="story-step-failures-aside">
          <div className="story-step-failures-aside-head">
            <span>
              {t("story:jobs.failureIgnored", {
                count: detail.putAside.length,
              })}
            </span>
            <button
              data-testid={`story-step-restore-all-${step}`}
              onClick={() => {
                for (const item of detail.putAside) {
                  restoreFailure(job.id, item.id);
                }
              }}
              type="button"
            >
              {t("story:jobs.failureRestoreAll")}
            </button>
          </div>
          <ul className="story-step-failures-list">
            {detail.putAside.map((item, index) => (
              <FailureRow
                action={t("story:jobs.failureRestore")}
                ignored
                item={item}
                key={item.id}
                onAction={() => restoreFailure(job.id, item.id)}
                story={story}
                testId={`story-step-aside-${step}-${index}`}
              />
            ))}
          </ul>
        </div>
      )}

      <footer className="story-step-failures-actions">
        {detail.failed.length > 0 && (
          <button
            data-testid={`story-step-ignore-all-${step}`}
            onClick={() => {
              for (const item of detail.failed) {
                ignoreFailure(job.id, item.id);
              }
            }}
            type="button"
          >
            {t("story:jobs.failureIgnoreAll")}
          </button>
        )}
        {canRetry && (
          <button
            data-testid={`story-step-retry-${step}`}
            onClick={() => {
              void retryFailed(story, job);
              onClose();
            }}
            type="button"
          >
            {t("story:jobs.retryFailed")}
          </button>
        )}
        <button
          data-testid={`story-step-failures-done-${step}`}
          onClick={onClose}
          type="button"
        >
          {t("story:jobs.failureClose")}
        </button>
      </footer>
    </div>,
    document.body,
  );
}

/** One piece that did not come back, what it was, and what it said. */
function FailureRow({
  action,
  ignored = false,
  item,
  onAction,
  story,
  testId,
}: {
  action: string;
  ignored?: boolean;
  item: StoryJobItem;
  onAction: () => void;
  story: StoryDocument;
  testId: string;
}) {
  const { t } = useTranslation();
  const said = failureText(item);
  const reason = said ?? t("story:jobs.failureNoReason");
  const label = failurePieceLabel(story, item, t);
  const raw = item.error;
  return (
    <li
      className={
        ignored
          ? "story-step-failures-row is-ignored"
          : "story-step-failures-row"
      }
      data-testid={testId}
    >
      <span className="story-step-failures-said">
        <span className="story-step-failures-place">{label}</span>
        <span className="story-step-failures-reason">{reason}</span>
        {raw !== undefined && raw !== "" && raw !== said && (
          <span className="story-step-failures-raw">
            {t("story:jobs.failureOriginal", { message: raw })}
          </span>
        )}
      </span>
      <button
        aria-label={t(
          ignored
            ? "story:jobs.failureRestoreOne"
            : "story:jobs.failureIgnoreOne",
          { piece: label },
        )}
        data-testid={`${testId}-action`}
        onClick={onAction}
        type="button"
      >
        {action}
      </button>
    </li>
  );
}

/**
 * Where the panel stands for the badge that opened it.
 *
 * To the right of the step column rather than over it, so the step list stays
 * readable while an error is being dealt with, and inside the viewport when
 * the badge is low enough that the panel would otherwise run off its bottom.
 */
function place(anchor: FailureAnchor): CSSProperties {
  const width = Math.min(400, window.innerWidth - 24);
  const left = Math.max(
    12,
    Math.min(anchor.right + 10, window.innerWidth - width - 12),
  );
  const top = Math.max(12, Math.min(anchor.top - 4, window.innerHeight - 140));
  return {
    left,
    maxHeight: `calc(100vh - ${top + 12}px)`,
    top,
    width,
  };
}
