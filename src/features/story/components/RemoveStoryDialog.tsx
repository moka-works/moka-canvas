import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { storyDeleteCost, type StoryDocument } from "../../../shared/domain";

/**
 * The question a story is taken out under.
 *
 * What it says is what the count is for: deleting a story stops the telling
 * from pointing at what was made for it, and does not delete anything. The
 * drawings stay in the shelf and the timeline it assembled stays in the
 * cutting room, so a reader deciding whether to answer yes is told what they
 * are and are not about to lose.
 */
export function RemoveStoryDialog({
  story,
  onCancel,
  onConfirm,
}: {
  story: StoryDocument;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const cost = storyDeleteCost(story);

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
        aria-labelledby="remove-story-title"
        aria-modal="true"
        className="dialog"
        data-testid="remove-story"
        role="alertdialog"
      >
        <h2 id="remove-story-title">
          {t("story:remove.title", { name: story.name })}
        </h2>
        <p>
          {t("story:remove.body", {
            chapters: cost.chapters,
            acts: cost.acts,
            pictures: cost.pictures,
            videos: cost.videos,
            voices: cost.voices,
          })}
        </p>
        <p className="dialog-note">{t("story:remove.keeps")}</p>
        <div className="dialog-actions">
          <button onClick={onCancel} type="button">
            {t("story:remove.cancel")}
          </button>
          <button
            autoFocus
            className="primary"
            data-testid="remove-story-confirm"
            onClick={onConfirm}
            type="button"
          >
            {t("story:remove.confirm")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
