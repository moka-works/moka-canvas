import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

/**
 * A question the room asks before doing something a reader cannot take back.
 *
 * Work that is overwritten, dropped, or thrown away is asked about first, and
 * the question says what is at stake rather than what the button says — a
 * reader agreeing to "Re-identify" is agreeing to the elements the new reading
 * does not find, so that is the sentence they are shown.
 */
export function ConfirmDialog({
  title,
  body,
  note,
  confirm,
  testId,
  onCancel,
  onConfirm,
  initialFocus = "confirm",
}: {
  title: string;
  body: string;
  note?: string;
  confirm: string;
  testId: string;
  onCancel: () => void;
  onConfirm: () => void;
  /** Which answer the keyboard starts on; a warning starts on staying. */
  initialFocus?: "confirm" | "cancel";
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
        aria-labelledby={`${testId}-title`}
        aria-modal="true"
        className="dialog"
        data-testid={testId}
        role="alertdialog"
      >
        <h2 id={`${testId}-title`}>{title}</h2>
        <p>{body}</p>
        {note !== undefined && <p className="dialog-note">{note}</p>}
        <div className="dialog-actions">
          <button
            autoFocus={initialFocus === "cancel"}
            data-testid={`${testId}-cancel`}
            onClick={onCancel}
            type="button"
          >
            {t("story:panels.cancel")}
          </button>
          <button
            autoFocus={initialFocus === "confirm"}
            className="primary"
            data-testid={`${testId}-confirm`}
            onClick={onConfirm}
            type="button"
          >
            {confirm}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
