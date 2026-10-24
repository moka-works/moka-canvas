import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateStore } from "./updateStore";

interface CurrentVersion {
  value?: string;
  error?: string;
}

/** A date the manifest carries, drawn in the reader's language when it parses. */
function releasedOn(date: string, language: string): string {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(
    parsed,
  );
}

/**
 * The update row of the system settings.
 *
 * Only an installation that can replace itself shows it: a web runtime, a
 * development build, and a Linux deb/rpm have nothing here to offer. Checking
 * is always the reader's choice; nothing is downloaded or restarted until the
 * button is pressed.
 */
export function UpdateSection() {
  const { t, i18n } = useTranslation();
  const supported = useUpdateStore((state) => state.supported);
  const status = useUpdateStore((state) => state.status);
  const available = useUpdateStore((state) => state.available);
  const downloaded = useUpdateStore((state) => state.downloaded);
  const total = useUpdateStore((state) => state.total);
  const error = useUpdateStore((state) => state.error);
  const [current, setCurrent] = useState<CurrentVersion>({});

  useEffect(() => {
    void useUpdateStore.getState().support();
  }, []);

  useEffect(() => {
    if (supported !== true) return;
    if (current.value !== undefined || current.error !== undefined) return;
    let live = true;
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((value) => {
        if (live) setCurrent({ value });
      })
      .catch((problem: unknown) => {
        if (live) {
          setCurrent({
            error: problem instanceof Error ? problem.message : String(problem),
          });
        }
      });
    return () => {
      live = false;
    };
  }, [supported, current]);

  if (supported !== true) return null;

  const percent =
    total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
  const language = i18n.resolvedLanguage ?? "en";

  return (
    <section
      aria-label={t("settings:update.title")}
      className="settings-section"
    >
      <h3 className="settings-heading">{t("settings:update.title")}</h3>
      <p className="settings-hint">
        {current.value !== undefined
          ? t("settings:update.currentVersion", { version: current.value })
          : current.error !== undefined
            ? t("settings:update.versionFailed", { reason: current.error })
            : t("settings:update.loadingVersion")}
      </p>
      <div className="settings-row">
        <button
          disabled={status === "checking" || status === "downloading"}
          onClick={() => void useUpdateStore.getState().check()}
          type="button"
        >
          {status === "checking"
            ? t("settings:update.checking")
            : t("settings:update.check")}
        </button>
      </div>

      {status === "up-to-date" && (
        <p className="update-status">{t("settings:update.upToDate")}</p>
      )}

      {available !== null && (status === "available" || status === "error") && (
        <div className="update-available">
          <p className="update-version">
            {t("settings:update.available", { version: available.version })}
          </p>
          {available.date !== undefined && (
            <p className="settings-hint">
              {t("settings:update.released", {
                date: releasedOn(available.date, language),
              })}
            </p>
          )}
          {available.body !== undefined && (
            <>
              <h4 className="update-notes-heading">
                {t("settings:update.notes")}
              </h4>
              <p className="update-notes">{available.body}</p>
            </>
          )}
          <div className="settings-row">
            <button
              onClick={() => void useUpdateStore.getState().install()}
              type="button"
            >
              {t("settings:update.download")}
            </button>
          </div>
        </div>
      )}

      {status === "downloading" && (
        <div className="update-progress">
          <div
            aria-label={t("settings:update.downloadingUnknown")}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={percent ?? undefined}
            className="update-progress-bar"
            role="progressbar"
          >
            <span
              className={percent === null ? "is-indeterminate" : undefined}
              style={{ width: percent === null ? "100%" : `${percent}%` }}
            />
          </div>
          <p className="settings-hint">
            {percent === null
              ? t("settings:update.downloadingUnknown")
              : t("settings:update.downloading", { percent })}
          </p>
        </div>
      )}

      {error !== null && (
        <p className="update-error" role="alert">
          {t("settings:update.error", { reason: error })}
        </p>
      )}
    </section>
  );
}
