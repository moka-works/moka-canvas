import { useTranslation } from "react-i18next";

import { MAX_IMAGES_PER_ASK } from "../../../shared/domain/constants";

/**
 * A step's bulk drawing press, with the number of pictures each place may be
 * asked for at once on its right edge.
 *
 * One model call makes one picture, so a place asked for several is several
 * calls made side by side; the press says how many before it is made, because
 * a set is minutes of a provider's time and not something to discover after.
 */
export function DrawCountButton({
  label,
  count,
  onCount,
  onRun,
  testId,
  primary = false,
}: {
  label: string;
  count: number;
  onCount: (count: number) => void;
  onRun: () => void;
  testId: string;
  primary?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span className="story-split">
      <button
        className={primary ? "primary" : undefined}
        data-testid={testId}
        onClick={onRun}
        type="button"
      >
        {label}
      </button>
      <label className="story-split-pick">
        <span className="story-split-label">{t("story:panels.drawCount")}</span>
        <select
          aria-label={t("story:panels.drawCountLabel")}
          data-testid={`${testId}-count`}
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
    </span>
  );
}
