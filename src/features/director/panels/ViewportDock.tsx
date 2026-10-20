import { useTranslation } from "react-i18next";
import {
  DIRECTOR_VIEWS,
  viewLabel,
  type DirectorView,
} from "../stage/viewModes";
import type { DirectorTransformMode } from "../types";

export interface ViewportDockProps {
  view: DirectorView;
  onView: (view: DirectorView) => void;
  transformMode: DirectorTransformMode;
  onTransformMode: (mode: DirectorTransformMode) => void;
  canTransform: boolean;
  onFocusSelection: () => void;
  onFitAll: () => void;
  onResetView: () => void;
  onDolly: (factor: number) => void;
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onToggleMotion: () => void;
}

const TRANSFORMS: DirectorTransformMode[] = ["translate", "rotate", "scale"];
const TRANSFORM_KEYS: Record<DirectorTransformMode, string> = {
  translate: "W",
  rotate: "E",
  scale: "R",
};

/**
 * The floating dock: the four tools a staged scene is worked with, grouped
 * as transform, path, view, and navigation. It floats over the viewport
 * rather than owning a row of its own, so the picture keeps the height.
 */
export function ViewportDock({
  view,
  onView,
  transformMode,
  onTransformMode,
  canTransform,
  onFocusSelection,
  onFitAll,
  onResetView,
  onDolly,
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
  onToggleMotion,
}: ViewportDockProps) {
  const { t } = useTranslation("director");
  return (
    <div aria-label={t("dock.label")} className="director-dock" role="toolbar">
      <div className="director-dock-group">
        {TRANSFORMS.map((mode) => (
          <button
            aria-label={t(`transform.${mode}`)}
            aria-pressed={transformMode === mode}
            className="director-dock-button"
            disabled={!canTransform}
            key={mode}
            onClick={() => onTransformMode(mode)}
            title={`${t(`transform.${mode}`)} (${TRANSFORM_KEYS[mode]})`}
            type="button"
          >
            {t(`transform.short.${mode}`)}
            <small>{TRANSFORM_KEYS[mode]}</small>
          </button>
        ))}
      </div>
      <div className="director-dock-group">
        {DIRECTOR_VIEWS.map((mode) => (
          <button
            aria-label={t(`view.${mode}`)}
            aria-pressed={view === mode}
            className="director-dock-button"
            key={mode}
            onClick={() => onView(mode)}
            title={t(`view.${mode}`)}
            type="button"
          >
            {viewLabel(mode)}
          </button>
        ))}
      </div>
      <div className="director-dock-group">
        <button
          className="director-dock-button"
          onClick={onFocusSelection}
          title={t("navigation.focus")}
          type="button"
        >
          {t("navigation.focusShort")}
        </button>
        <button
          className="director-dock-button"
          onClick={onFitAll}
          title={t("navigation.fit")}
          type="button"
        >
          {t("navigation.fitShort")}
        </button>
        <button
          className="director-dock-button"
          onClick={() => onDolly(0.8)}
          title={t("navigation.closer")}
          type="button"
        >
          +
        </button>
        <button
          className="director-dock-button"
          onClick={() => onDolly(1.25)}
          title={t("navigation.farther")}
          type="button"
        >
          −
        </button>
        <button
          className="director-dock-button"
          onClick={onResetView}
          title={t("navigation.reset")}
          type="button"
        >
          {t("navigation.resetShort")}
        </button>
      </div>
      <div className="director-dock-group">
        <button
          aria-pressed={leftOpen}
          className="director-dock-button"
          onClick={onToggleLeft}
          title={t("dock.board")}
          type="button"
        >
          ◧
        </button>
        <button
          aria-pressed={rightOpen}
          className="director-dock-button"
          onClick={onToggleRight}
          title={t("dock.card")}
          type="button"
        >
          ◨
        </button>
        <button
          className="director-dock-button"
          onClick={onToggleMotion}
          title={t("dock.timeline")}
          type="button"
        >
          ▤
        </button>
      </div>
    </div>
  );
}
