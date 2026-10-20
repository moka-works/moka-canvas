import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DIRECTOR_RENDER_MODES,
  directorControlMode,
  type DirectorScene,
  type DirectorShot,
} from "../../../shared/domain";
import type { DirectorCaptureResolution } from "../stage/capture";
import { outputSize } from "../stage/framing";

export interface DirectorDeliveryOptions {
  resolution: DirectorCaptureResolution;
  mode: (typeof DIRECTOR_RENDER_MODES)[number];
  blocking: boolean;
  transcode: boolean;
}

export interface DirectorDeliveryError {
  message: string;
  detail?: string;
}

const RESOLUTIONS: readonly {
  value: DirectorCaptureResolution;
  label: string;
}[] = [
  { value: 1280, label: "720p" },
  { value: 1920, label: "1080p" },
  { value: 3840, label: "4K" },
];

/** One shot's delivery: what the frame is drawn at, and what else is kept. */
export function DirectorDeliverDialog({
  scene,
  shot,
  canRecord,
  recordingReason,
  busy,
  error,
  onClose,
  onCancel,
  onDeliver,
}: {
  scene: DirectorScene;
  shot: DirectorShot;
  canRecord: boolean;
  recordingReason?: string;
  busy: boolean;
  error: DirectorDeliveryError | null;
  onClose: () => void;
  /** Stops work in flight, leaving the files already filed on the shelf. */
  onCancel: () => void;
  onDeliver: (options: DirectorDeliveryOptions) => void;
}) {
  const { t } = useTranslation("director");
  const [resolution, setResolution] = useState<DirectorCaptureResolution>(1920);
  const [mode, setMode] = useState<DirectorDeliveryOptions["mode"]>("lit");
  const [blocking, setBlocking] = useState(false);
  const [transcode, setTranscode] = useState(true);
  const size = outputSize(shot.aspectRatio, resolution);
  const control = directorControlMode(mode);

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        aria-label={t("deliver.title")}
        aria-modal="true"
        className="dialog director-deliver-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          onDeliver({ resolution, mode, blocking, transcode });
        }}
        role="dialog"
      >
        <h2>{t("deliver.title")}</h2>
        <p>{t("deliver.intro", { scene: scene.title, shot: shot.name })}</p>
        <label className="dialog-field">
          <span>{t("deliver.resolution")}</span>
          <select
            disabled={busy}
            onChange={(event) =>
              setResolution(
                Number(event.target.value) as DirectorCaptureResolution,
              )
            }
            value={String(resolution)}
          >
            {RESOLUTIONS.map((entry) => (
              <option key={entry.value} value={String(entry.value)}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <p className="director-deliver-size">
          {t("deliver.size", {
            width: size.width,
            height: size.height,
            aspect: shot.aspectRatio,
            seconds: shot.duration,
            fps: shot.fps,
          })}
        </p>
        <label className="dialog-field">
          <span>{t("deliver.frameMode")}</span>
          <select
            disabled={busy}
            onChange={(event) =>
              setMode(event.target.value as DirectorDeliveryOptions["mode"])
            }
            value={mode}
          >
            {DIRECTOR_RENDER_MODES.map((entry) => (
              <option key={entry} value={entry}>
                {t(`renderMode.${entry}`)}
              </option>
            ))}
          </select>
        </label>
        {control ? (
          <p className="director-deliver-note">{t("deliver.controlNote")}</p>
        ) : (
          <label className="settings-check">
            <input
              checked={blocking && canRecord}
              disabled={busy || !canRecord}
              onChange={(event) => setBlocking(event.target.checked)}
              type="checkbox"
            />
            <span>{t("deliver.blocking")}</span>
          </label>
        )}
        {!canRecord && (
          <p className="director-deliver-note">
            {recordingReason !== undefined && recordingReason !== ""
              ? t("deliver.blockingUnsupported", { reason: recordingReason })
              : t("deliver.blockingUnavailable")}
          </p>
        )}
        {!control && blocking && canRecord && (
          <>
            <label className="settings-check">
              <input
                checked={transcode}
                disabled={busy}
                onChange={(event) => setTranscode(event.target.checked)}
                type="checkbox"
              />
              <span>{t("deliver.transcode")}</span>
            </label>
            <p className="director-deliver-note">
              {t("deliver.transcodeHint")}
            </p>
          </>
        )}
        {error && (
          <details className="director-save-error" role="alert">
            <summary>{error.message}</summary>
            {error.detail && <pre>{error.detail}</pre>}
          </details>
        )}
        <div className="dialog-actions">
          <button
            className="button"
            onClick={busy ? onCancel : onClose}
            type="button"
          >
            {busy ? t("deliver.cancelWork") : t("confirm.cancel")}
          </button>
          <button className="button is-primary" disabled={busy} type="submit">
            {busy
              ? t("deliver.working")
              : control
                ? t("deliver.export")
                : t("deliver.confirm")}
          </button>
        </div>
      </form>
    </div>
  );
}
