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
  max = MAX_IMAGES_PER_ASK,
  kind = "picture",
  title,
}: {
  label: string;
  /** The long reason the press stands for, where it has one. */
  title?: string;
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
  /** How many one press may ask for; a clip press asks for fewer. */
  max?: number;
  /** What one press asks for: pictures each place keeps, or clips to choose between. */
  kind?: "picture" | "clip";
}) {
  const { t } = useTranslation();
  const words =
    kind === "clip"
      ? {
          count: "story:storyboard.filmCount",
          aria: "story:storyboard.filmCountLabel",
          option: "story:storyboard.filmCountOption",
          hint: "story:storyboard.videoRewritePromptsHint",
        }
      : {
          count: "story:panels.drawCount",
          aria: "story:panels.drawCountLabel",
          option: "story:panels.drawCountOption",
          hint: "story:panels.rewritePromptsHint",
        };
  return (
    <span className="story-split">
      <button
        className={primary ? "primary" : undefined}
        data-testid={testId}
        disabled={disabled}
        onClick={onRun}
        title={title}
        type="button"
      >
        {label}
      </button>
      <label
        className={`story-split-pick${onRewrite === undefined ? "" : " is-before-rewrite"}`}
      >
        <span className="story-split-label">{t(words.count)}</span>
        <select
          aria-label={t(words.aria)}
          data-testid={`${testId}-count`}
          disabled={disabled}
          onChange={(event) => onCount(Number(event.target.value))}
          value={count}
        >
          {Array.from({ length: max }, (_, at) => at + 1).map((each) => (
            <option key={each} value={each}>
              {t(words.option, { count: each })}
            </option>
          ))}
        </select>
      </label>
      {onRewrite !== undefined && (
        <label className="story-split-rewrite" title={t(words.hint)}>
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
