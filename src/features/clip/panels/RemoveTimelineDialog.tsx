import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { TimelineDocument } from "../../../shared/domain";

/**
 * The light question a timeline with clips on it is deleted under.
 *
 * Deletion is the rail selector's business, so this is asked from the column
 * beside the stage rather than from the strip; it still hangs from the window's
 * own box, where a question covers everything behind it.
 */
export function RemoveTimelineDialog({
  timeline,
  onCancel,
  onConfirm,
}: {
  timeline: TimelineDocument;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const count = timeline.clips.length;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <div
        aria-labelledby="remove-timeline-title"
        aria-modal="true"
        className="dialog"
        role="alertdialog"
      >
        <h2 id="remove-timeline-title">
          {t("clip:timelinePicker.deleteTitle")}
        </h2>
        <p>
          {t("clip:timelinePicker.deleteBody", {
            name: timeline.name,
            total: count,
            noun: t(
              count === 1 ? "clip:common.clipOne" : "clip:common.clipMany",
            ),
          })}
        </p>
        <div className="dialog-actions">
          <button onClick={onCancel} type="button">
            {t("clip:common.cancel")}
          </button>
          <button
            autoFocus
            className="primary"
            onClick={onConfirm}
            type="button"
          >
            {t("clip:timelinePicker.deleteConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
