import { useTranslation } from "react-i18next";
import type { TimelineDocument } from "../../../shared/domain";
import { redo, undo } from "../../editor/commands/execute";
import { useCanUndo } from "../../editor/panels/PageTopBar";
import { useHistoryStore } from "../../editor/stores/historyStore";
import {
  DuplicateIcon,
  FitIcon,
  MagnetIcon,
  RedoIcon,
  ScissorsIcon,
  TrashIcon,
  UndoIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "../components/ClipIcons";
import {
  clipsCrossingPlayhead,
  deleteSelection,
  duplicateSelection,
  splitSelectionAtPlayhead,
} from "../interactions/clipActions";
import { useClipStore } from "../stores/clipStore";
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC, contentMs } from "./geometry";

/** One press of the buttons, and the step the slider's logarithm is anchored on. */
export const ZOOM_STEP = 1.5;

interface TimelineToolbarProps {
  timeline: TimelineDocument;
}

/**
 * The timeline's toolbar: the tools on the left, the view on the right.
 *
 * Every button here acts at once — pointer, razor and the rest of the modes
 * are not this room's, so nothing waits for a second click. The edit group
 * asks the same questions the actions do: a split with nothing under the
 * playhead, a duplicate or a deletion with nothing chosen, or an undo with
 * nothing to undo are each said by going quiet rather than by refusing.
 */
export function TimelineToolbar({ timeline }: TimelineToolbarProps) {
  const { t } = useTranslation();
  const pxPerSec = useClipStore((state) => state.view.pxPerSec);
  const viewportPx = useClipStore((state) => state.viewportPx);
  const playheadMs = useClipStore((state) => state.playheadMs);
  const selection = useClipStore((state) => state.selection);
  const zoomBy = useClipStore((state) => state.zoomBy);
  const zoomTo = useClipStore((state) => state.zoomTo);
  const fit = useClipStore((state) => state.fit);
  const snapEnabled = useClipStore((state) => state.snapEnabled);
  const setSnapEnabled = useClipStore((state) => state.setSnapEnabled);
  const placement = useClipStore((state) => state.placement);
  const setPlacement = useClipStore((state) => state.setPlacement);
  const rippleScope = useClipStore((state) => state.rippleScope);
  const setRippleScope = useClipStore((state) => state.setRippleScope);
  const canUndo = useCanUndo();
  const canRedo = useHistoryStore((state) => state.redoStack.length > 0);

  const splitsHere = clipsCrossingPlayhead(timeline, playheadMs).length > 0;
  const hasClips = selection.clipIds.length > 0;
  const hasSelection = hasClips || selection.transitionId !== null;

  return (
    <div className="clip-tl-toolbar">
      <div className="clip-tl-toolbar-actions">
        <button
          aria-label={t("clip:common.splitAtThePlayhead")}
          className="clip-tl-button"
          data-testid="clip-split"
          disabled={!splitsHere}
          onClick={() => splitSelectionAtPlayhead()}
          title={t("clip:common.splitAtThePlayhead")}
          type="button"
        >
          <ScissorsIcon size={16} />
        </button>
        <button
          aria-label={t("clip:common.duplicateSelection")}
          className="clip-tl-button"
          data-testid="clip-duplicate"
          disabled={!hasClips}
          onClick={() => duplicateSelection()}
          title={t("clip:common.duplicateSelection")}
          type="button"
        >
          <DuplicateIcon size={16} />
        </button>
        <button
          aria-label={t("clip:common.deleteSelection")}
          className="clip-tl-button"
          data-testid="clip-delete"
          disabled={!hasSelection}
          onClick={() => deleteSelection()}
          title={t("clip:common.deleteSelection")}
          type="button"
        >
          <TrashIcon size={16} />
        </button>
        <button
          aria-label={t("clip:common.undo")}
          className="clip-tl-button"
          data-testid="clip-undo"
          disabled={!canUndo}
          onClick={() => undo()}
          title={t("clip:common.undo")}
          type="button"
        >
          <UndoIcon size={16} />
        </button>
        <button
          aria-label={t("clip:common.redo")}
          className="clip-tl-button"
          data-testid="clip-redo"
          disabled={!canRedo}
          onClick={() => redo()}
          title={t("clip:common.redo")}
          type="button"
        >
          <RedoIcon size={16} />
        </button>
        <div
          aria-label={t("clip:toolbar.placement")}
          className="clip-tl-modes"
          role="group"
        >
          <button
            aria-pressed={placement === "insert"}
            className={
              placement === "insert"
                ? "clip-tl-button is-active"
                : "clip-tl-button"
            }
            data-testid="clip-placement-insert"
            onClick={() => setPlacement("insert")}
            title={t("clip:toolbar.insertHint")}
            type="button"
          >
            {t("clip:toolbar.insert")}
          </button>
          <button
            aria-pressed={placement === "overwrite"}
            className={
              placement === "overwrite"
                ? "clip-tl-button is-active"
                : "clip-tl-button"
            }
            data-testid="clip-placement-overwrite"
            onClick={() => setPlacement("overwrite")}
            title={t("clip:toolbar.overwriteHint")}
            type="button"
          >
            {t("clip:toolbar.overwrite")}
          </button>
        </div>
        <div
          aria-label={t("clip:toolbar.scope")}
          className="clip-tl-modes"
          role="group"
        >
          <button
            aria-pressed={rippleScope === "all"}
            className={
              rippleScope === "all"
                ? "clip-tl-button is-active"
                : "clip-tl-button"
            }
            data-testid="clip-scope-all"
            disabled={placement !== "insert"}
            onClick={() => setRippleScope("all")}
            title={t("clip:toolbar.scopeAllHint")}
            type="button"
          >
            {t("clip:toolbar.scopeAll")}
          </button>
          <button
            aria-pressed={rippleScope === "track"}
            className={
              rippleScope === "track"
                ? "clip-tl-button is-active"
                : "clip-tl-button"
            }
            data-testid="clip-scope-track"
            disabled={placement !== "insert"}
            onClick={() => setRippleScope("track")}
            title={t("clip:toolbar.scopeTrackHint")}
            type="button"
          >
            {t("clip:toolbar.scopeTrack")}
          </button>
        </div>
        <button
          aria-label={t("clip:toolbar.snapping")}
          aria-pressed={snapEnabled}
          className="clip-tl-button"
          data-testid="clip-snap"
          onClick={() => setSnapEnabled(!snapEnabled)}
          title={t("clip:toolbar.snapHint")}
          type="button"
        >
          <MagnetIcon size={16} />
        </button>
      </div>
      <div className="clip-tl-toolbar-view">
        <button
          aria-label={t("clip:common.zoomOut")}
          className="clip-tl-button"
          data-testid="clip-zoom-out"
          disabled={pxPerSec <= MIN_PX_PER_SEC}
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          title={t("clip:common.zoomOut")}
          type="button"
        >
          <ZoomOutIcon size={16} />
        </button>
        <input
          aria-label={t("clip:toolbar.zoom")}
          className="clip-tl-slider"
          data-testid="clip-zoom-slider"
          max={Math.log(MAX_PX_PER_SEC)}
          min={Math.log(MIN_PX_PER_SEC)}
          onChange={(event) => zoomTo(Math.exp(Number(event.target.value)))}
          step={0.01}
          type="range"
          value={Math.log(pxPerSec)}
        />
        <button
          aria-label={t("clip:common.zoomIn")}
          className="clip-tl-button"
          data-testid="clip-zoom-in"
          disabled={pxPerSec >= MAX_PX_PER_SEC}
          onClick={() => zoomBy(ZOOM_STEP)}
          title={t("clip:common.zoomIn")}
          type="button"
        >
          <ZoomInIcon size={16} />
        </button>
        <button
          aria-label={t("clip:toolbar.fitToWindow")}
          className="clip-tl-button"
          data-testid="clip-zoom-fit"
          onClick={() => fit(viewportPx, contentMs(timeline, playheadMs))}
          title={t("clip:toolbar.fitToWindow")}
          type="button"
        >
          <FitIcon size={16} />
        </button>
      </div>
    </div>
  );
}
