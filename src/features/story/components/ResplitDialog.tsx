import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

/**
 * The question a story is split again under.
 *
 * Splitting again is not free: a chapter keeps everything made for it as long
 * as it stands where it stood, so what the reader is asked to agree to is the
 * words that will be written over and the boards that will go with the
 * chapters the new telling has no room for.
 */
export function ResplitDialog({
  cost,
  split,
  onCancel,
  onConfirm,
}: {
  cost: { chapters: number; acts: number };
  /** Whether the new table comes from the manuscript rather than a count. */
  split: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <div
        aria-labelledby="resplit-title"
        aria-modal="true"
        className="dialog"
        data-testid="resplit-story"
        role="alertdialog"
      >
        <h2 id="resplit-title">{t("story:outline.resplitTitle")}</h2>
        <p>
          {split
            ? t("story:outline.resplitBodySplit", { chapters: cost.chapters })
            : t("story:outline.resplitBody", {
                chapters: cost.chapters,
                acts: cost.acts,
              })}
        </p>
        <p className="dialog-note">{t("story:outline.resplitKeeps")}</p>
        <div className="dialog-actions">
          <button onClick={onCancel} type="button">
            {t("story:outline.resplitCancel")}
          </button>
          <button
            autoFocus
            className="primary"
            data-testid="resplit-story-confirm"
            onClick={onConfirm}
            type="button"
          >
            {t("story:outline.resplitConfirm")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
