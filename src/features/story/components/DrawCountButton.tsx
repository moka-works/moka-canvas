import { useTranslation } from "react-i18next";

import { MAX_IMAGES_PER_ASK } from "../../../shared/domain/constants";

/**
 * A step's bulk drawing press, with the number of pictures each place may be
 * asked for at once on its right edge.
 *
 * One model call makes one picture, so a place asked for several is several
 * calls made side by side; the press says how many before it is made, because
 * a set is minutes of a provider's time and not something to discover after.
 * Beside the count stands the choice to rewrite each place's words for its
 * picture model first — once per place, however many pictures the set holds.
 */
export function DrawCountButton({
  label,
  count,
  onCount,
  onRun,
  testId,
  primary = false,
  rewrite,
  onRewrite,
  disabled = false,
}: {
  label: string;
  count: number;
  onCount: (count: number) => void;
  onRun: () => void;
  testId: string;
  primary?: boolean;
  /** Whether the prompts are rewritten before the pictures are drawn. */
  rewrite?: boolean;
  /** The switch's change; absent hides the switch. */
  onRewrite?: (rewrite: boolean) => void;
  /** Whether the press waits on another ask just now. */
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span className="story-split">
      <button
        className={primary ? "primary" : undefined}
        data-testid={testId}
        disabled={disabled}
        onClick={onRun}
        type="button"
      >
        {label}
      </button>
      <label
        className={`story-split-pick${onRewrite === undefined ? "" : " is-before-rewrite"}`}
      >
        <span className="story-split-label">{t("story:panels.drawCount")}</span>
        <select
          aria-label={t("story:panels.drawCountLabel")}
          data-testid={`${testId}-count`}
          disabled={disabled}
          onChange={(event) => onCount(Number(event.target.value))}
          value={count}
        >
          {Array.from({ length: MAX_IMAGES_PER_ASK }, (_, at) => at + 1).map(
            (each) => (
              <option key={each} value={each}>
                {t("story:panels.drawCountOption", { count: each })}
              </option>
            ),
          )}
        </select>
      </label>
      {onRewrite !== undefined && (
        <label
          className="story-split-rewrite"
          title={t("story:panels.rewritePromptsHint")}
        >
          <input
            checked={rewrite ?? false}
            data-testid={`${testId}-rewrite`}
            disabled={disabled}
            onChange={(event) => onRewrite(event.target.checked)}
            type="checkbox"
          />
          <span className="story-split-label">
            {t("story:panels.rewritePrompts")}
          </span>
        </label>
      )}
    </span>
  );
}
