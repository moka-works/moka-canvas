import { useTranslation } from "react-i18next";

import { formatDuration } from "../../../shared/domain/story";
import type { StoryChapter } from "../../../shared/domain/types";
import { chapterBudget } from "../jobs/budget";

/**
 * The board's own running time against the episode's target.
 *
 * Said beside the target rather than over the board: the difference is the
 * reader's to accept, and a chapter that plans five seconds for a minute's
 * episode is worth seeing before its pictures are drawn.
 */
export function BudgetHint({ chapter }: { chapter: StoryChapter }) {
  const { t } = useTranslation();
  const budget = chapterBudget(chapter);
  if (budget.plannedMs === 0 || budget.targetMs <= 0) return null;
  const percent = Math.round((budget.ratio - 1) * 100);
  return (
    <span
      className={`story-hint story-budget is-${budget.state}`}
      data-testid="story-board-budget"
      title={t("story:storyboard.budgetHint")}
    >
      {t("story:storyboard.budget", {
        planned: formatDuration(budget.plannedMs),
        target: formatDuration(budget.targetMs),
        percent: percent > 0 ? `+${percent}` : String(percent),
      })}
    </span>
  );
}
