import { useTranslation } from "react-i18next";

import type { StoryJobItem, StoryJobRecord } from "../../../api/story";
import { formatDuration } from "../../../shared/domain";
import { modelNameOf, useModelStore } from "../../settings/modelStore";
import {
  piecesProgress,
  useStoryJobStopping,
  useStoryJobStore,
  type ActRun,
} from "../stores/storyJobStore";
import { useElapsed } from "../steps/useElapsed";

/** How long a batch runs before the reader is told it may be a while. */
const SLOW_MS = 90_000;

/**
 * The models an act's standing batches were actually handed, at the act's head.
 *
 * A place may keep several models, and which one a batch gets is settled when
 * the batch is asked rather than when the list was picked. The head says the
 * models in hand rather than the ones on offer, so a reader watching the board
 * sees where the work really went — folded or not.
 */
export function RunningModels({
  runs,
  testId,
}: {
  runs: ActRun[];
  testId: string;
}) {
  const { t } = useTranslation();
  const view = useModelStore((state) => state.view);
  if (runs.length === 0) return null;
  const models = [
    ...new Set(runs.map(({ job }) => modelNameOf(view, job.model))),
  ].join(" / ");
  return (
    <span className="story-act-asking" data-testid={testId} title={models}>
      {t("story:storyboard.asking", { models })}
    </span>
  );
}

/**
 * One batch that is out, with the clock it keeps.
 *
 * A bar stands where the work stands — inside the act it is making something
 * for, or over an episode being boarded — and says only its own batch: what it
 * is doing, how many of its pieces have come home, and how long it has been
 * gone. Two batches out at once are two bars, neither written over by the
 * other, and either one may be stopped from where it stands.
 */
export function RunningBar({
  job,
  label,
  pieces,
  testId,
  model,
}: {
  job: StoryJobRecord;
  /** What this batch is doing, in the room's own words. */
  label: string;
  /** The pieces this bar counts: the batch's own, or the ones in one act. */
  pieces: StoryJobItem[];
  testId: string;
  /** The model the batch was really asked of, where the label does not say. */
  model?: string;
}) {
  const { t } = useTranslation();
  const elapsed = useElapsed(job.createdAt);
  const stopping = useStoryJobStopping(job.id);
  const progress = piecesProgress(pieces);
  return (
    <div className="story-running" data-testid={testId} role="status">
      <span>
        {label}
        {model !== undefined && (
          <>
            {" · "}
            {model}
          </>
        )}
        {pieces.length > 1 && (
          <>
            {" · "}
            {t("story:jobs.busy", progress)}
          </>
        )}
        {" · "}
        {formatDuration(elapsed)}
      </span>
      {elapsed >= SLOW_MS && (
        <span className="story-hint">{t("story:outline.slow")}</span>
      )}
      {stopping ? (
        <span className="story-hint" data-testid={`${testId}-stopping`}>
          {t("story:jobs.stopping")}
        </span>
      ) : (
        <button
          className="link"
          data-testid={`${testId}-cancel`}
          onClick={() => void useStoryJobStore.getState().cancel(job.id)}
          type="button"
        >
          {t("story:outline.cancel")}
        </button>
      )}
    </div>
  );
}
