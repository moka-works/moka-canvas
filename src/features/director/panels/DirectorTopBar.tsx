import { useTranslation } from "react-i18next";
import type { DirectorRenderMode, DirectorScene } from "../../../shared/domain";
import type { DirectorMode } from "../types";

const MODES: DirectorMode[] = ["stage", "perform", "motion", "lens"];

export interface DirectorTopBarProps {
  scene: DirectorScene;
  mode: DirectorMode;
  onMode: (mode: DirectorMode) => void;
  onBack: () => void;
  onSelectShot: (shotId: string) => void;
  onAddShot: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  saveLabel: string;
  saveTone: "saved" | "saving" | "failed" | "conflict";
  onRetrySave: () => void;
  onOnboarding: () => void;
  onDeliver: () => void;
  delivering: boolean;
  deliverDisabled?: boolean;
  renderMode: DirectorRenderMode;
  onRenderMode: (mode: DirectorRenderMode) => void;
}

/**
 * The slate line: which scene and shot are open, what mode is being worked
 * in, whether the document has been written, and the two actions that leave
 * the room — undo and delivery.
 */
export function DirectorTopBar({
  scene,
  mode,
  onMode,
  onBack,
  onSelectShot,
  onAddShot,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  saveLabel,
  saveTone,
  onRetrySave,
  onOnboarding,
  onDeliver,
  delivering,
  deliverDisabled,
  renderMode,
  onRenderMode,
}: DirectorTopBarProps) {
  const { t } = useTranslation(["director", "editor"]);
  return (
    <header className="director-topbar">
      <button className="button" onClick={onBack} type="button">
        {t("director:page.back")}
      </button>
      <h1>{scene.title}</h1>
      <div
        aria-label={t("director:shots.strip")}
        className="director-shot-strip"
        role="tablist"
      >
        {scene.shots.map((shot) => (
          <button
            aria-selected={scene.activeShotId === shot.id}
            className="director-shot-chip"
            key={shot.id}
            onClick={() => onSelectShot(shot.id)}
            role="tab"
            title={`${shot.duration}s · ${shot.aspectRatio} · ${shot.fps}fps`}
            type="button"
          >
            <span>{shot.name}</span>
            <small>
              {shot.duration}s · {shot.aspectRatio}
            </small>
          </button>
        ))}
        <button
          aria-label={t("director:shots.add")}
          className="director-shot-add"
          onClick={onAddShot}
          title={t("director:shots.add")}
          type="button"
        >
          +
        </button>
      </div>
      <div
        aria-label={t("director:mode.label")}
        className="director-modes"
        role="tablist"
      >
        {MODES.map((item) => (
          <button
            aria-selected={mode === item}
            className="director-mode"
            key={item}
            onClick={() => onMode(item)}
            role="tab"
            type="button"
          >
            {t(`director:mode.${item}`)}
          </button>
        ))}
      </div>
      <div className="director-topbar-actions">
        <label className="director-render-select">
          <span>{t("director:renderMode.label")}</span>
          <select
            onChange={(event) =>
              onRenderMode(event.target.value as DirectorRenderMode)
            }
            value={renderMode}
          >
            <option value="lit">{t("director:renderMode.lit")}</option>
            <option value="blockout">
              {t("director:renderMode.blockout")}
            </option>
          </select>
        </label>
        <span className={`director-save-status is-${saveTone}`} role="status">
          {saveLabel}
        </span>
        {saveTone === "failed" || saveTone === "conflict" ? (
          <button className="button" onClick={onRetrySave} type="button">
            {t("director:save.retry")}
          </button>
        ) : null}
        <button
          aria-label={t("editor:action.undo")}
          className="director-icon-button"
          disabled={!canUndo}
          onClick={onUndo}
          title={t("editor:action.undo")}
          type="button"
        >
          ↶
        </button>
        <button
          aria-label={t("editor:action.redo")}
          className="director-icon-button"
          disabled={!canRedo}
          onClick={onRedo}
          title={t("editor:action.redo")}
          type="button"
        >
          ↷
        </button>
        <button
          aria-label={t("director:onboarding.open")}
          className="director-icon-button"
          onClick={onOnboarding}
          title={t("director:onboarding.open")}
          type="button"
        >
          ?
        </button>
        <button
          className="button director-deliver"
          disabled={delivering || deliverDisabled}
          onClick={onDeliver}
          type="button"
        >
          {delivering
            ? t("director:deliver.working")
            : t("director:deliver.action")}
        </button>
      </div>
    </header>
  );
}
