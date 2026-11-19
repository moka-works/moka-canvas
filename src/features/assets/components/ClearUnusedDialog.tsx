import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { assetsApi } from "../../../api";
import type { ResourceEntry } from "../../../shared/domain";
import { formatBytes } from "../../editor/canvas/mediaCards";
import { useAppStore } from "../../editor/stores/appStore";
import {
  saveTrouble,
  settleBeforeFiling,
  useProjectStore,
} from "../../editor/stores/projectStore";

/**
 * The question before the files room sweeps what nothing holds.
 *
 * A sweep cannot be taken back, so the confirmation says what leaves rather
 * than only what the button says: the count, the room the files take, and the
 * fact that their bytes go with them. Confirming sends the very files the
 * confirmation described, and the document still has the last word — a file
 * anything holds comes back in `kept` instead of disappearing under it.
 */
export function ClearUnusedDialog({
  entries,
  onClose,
}: {
  entries: readonly ResourceEntry[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const bytes = entries.reduce(
    (total, entry) => total + (entry.bytes ?? entry.probe?.bytes ?? 0),
    0,
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const clear = async () => {
    setBusy(true);
    // What is waiting must land first: the sweep writes the document from the
    // server's side, and a change still on its way would rest on a revision
    // the sweep has replaced.
    if (!(await settleBeforeFiling())) {
      const trouble = saveTrouble();
      useAppStore
        .getState()
        .pushToast("error", trouble.message, undefined, trouble.detail);
      setBusy(false);
      return;
    }
    try {
      const result = await assetsApi.clearUnused(
        entries.map((entry) => entry.id),
      );
      useProjectStore.getState().removeAssetEntries(result.removed, result);
      const app = useAppStore.getState();
      if (result.removed.length > 0) {
        app.pushToast(
          "success",
          result.removed.length === 1
            ? t("assets:clear.doneOne")
            : t("assets:clear.doneMany", { count: result.removed.length }),
        );
      }
      if (result.kept.length > 0) {
        app.pushToast(
          "info",
          result.kept.length === 1
            ? t("assets:clear.keptOne")
            : t("assets:clear.keptMany", { count: result.kept.length }),
        );
      }
      onClose();
    } catch (error) {
      useAppStore
        .getState()
        .pushToast(
          "error",
          error instanceof Error ? error.message : t("assets:clear.failed"),
        );
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      role="presentation"
    >
      <div
        aria-labelledby="clear-unused-title"
        aria-modal="true"
        className="dialog"
        data-testid="clear-unused-dialog"
        role="alertdialog"
      >
        <h2 id="clear-unused-title">{t("assets:clear.title")}</h2>
        <p>
          {entries.length === 1
            ? t("assets:clear.bodyOne", { bytes: formatBytes(bytes) })
            : t("assets:clear.bodyMany", {
                count: entries.length,
                bytes: formatBytes(bytes),
              })}
        </p>
        <p className="dialog-note">{t("assets:clear.note")}</p>
        <div className="dialog-actions">
          <button
            autoFocus
            data-testid="clear-unused-cancel"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            {t("editor:action.cancel")}
          </button>
          <button
            className="danger"
            data-testid="clear-unused-confirm"
            disabled={busy}
            onClick={() => void clear()}
            type="button"
          >
            {busy
              ? t("assets:clear.working")
              : entries.length === 1
                ? t("assets:clear.confirmOne")
                : t("assets:clear.confirmMany", { count: entries.length })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
