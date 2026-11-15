import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import {
  actsRegenerationCost,
  keyframeCount,
  type StoryChapter,
} from "../../../shared/domain";

/**
 * How a board whose outline has moved on follows it.
 *
 * Two ways, and they are not the same work: rewriting the prompts the change
 * touches keeps every picture, clip and voice already made, while rebuilding
 * the episode writes the whole board again from the new words. The reader
 * chooses, and the chooser says what each costs before anything is asked for.
 */
export function OutlineSyncDialog({
  chapter,
  onCancel,
  onPatch,
  onRebuild,
}: {
  chapter: StoryChapter;
  onCancel: () => void;
  onPatch: () => void;
  onRebuild: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"patch" | "rebuild">("patch");
  const cost = actsRegenerationCost(chapter);
  const frames = keyframeCount(chapter);

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
        aria-labelledby="outline-sync-title"
        aria-modal="true"
        className="dialog"
        data-testid="story-outline-sync"
        role="alertdialog"
      >
        <h2 id="outline-sync-title">{t("story:storyboard.syncTitle")}</h2>
        <p>{t("story:storyboard.syncLead")}</p>

        <label className="dialog-choice">
          <input
            checked={mode === "patch"}
            data-testid="story-outline-sync-patch"
            name="outline-sync"
            onChange={() => setMode("patch")}
            type="radio"
          />
          <span>
            {t("story:storyboard.syncPatch")}
            <small>{t("story:storyboard.syncPatchHint")}</small>
          </span>
        </label>
        <label className="dialog-choice">
          <input
            checked={mode === "rebuild"}
            data-testid="story-outline-sync-rebuild"
            name="outline-sync"
            onChange={() => setMode("rebuild")}
            type="radio"
          />
          <span>
            {t("story:storyboard.syncRebuild")}
            <small>{t("story:storyboard.syncRebuildHint")}</small>
          </span>
        </label>

        {mode === "rebuild" ? (
          <p className="dialog-note" data-testid="story-outline-sync-cost">
            {t("story:storyboard.syncRebuildCost", {
              acts: cost.acts,
              frames,
              drawn: cost.drawn,
              filmed: cost.filmed,
            })}
          </p>
        ) : (
          <p className="dialog-note">{t("story:storyboard.syncPatchNote")}</p>
        )}

        <div className="dialog-actions">
          <button
            data-testid="story-outline-sync-cancel"
            onClick={onCancel}
            type="button"
          >
            {t("story:storyboard.syncCancel")}
          </button>
          <button
            autoFocus
            className="primary"
            data-testid="story-outline-sync-start"
            onClick={mode === "patch" ? onPatch : onRebuild}
            type="button"
          >
            {t("story:storyboard.syncStart")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
