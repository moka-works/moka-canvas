import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { historyBoundary } from "../editor/commands/execute";
import { AssetPickerModal } from "../editor/components/AssetPickerModal";
import { PanelUnfold } from "../editor/components/PanelFold";
import { PanelResizer } from "../editor/components/PanelResizer";
import { panelWidthStyle } from "../editor/components/panelWidthVars";
import { useAppStore } from "../editor/stores/appStore";
import { usePanelFolds } from "../editor/stores/panelFolds";
import { usePanelWidths } from "../editor/stores/panelWidths";
import { useProjectStore } from "../editor/stores/projectStore";
import { useRunStore } from "../editor/stores/runStore";
import { i18n } from "../../shared/i18n";
import { ClipShortcutsDialog } from "./components/ClipShortcutsDialog";
import { ClipTopBar } from "./components/ClipTopBar";
import { TimelineIcon } from "./components/ClipIcons";
import { StageSplit } from "./components/StageSplit";
import { TimelineDialog } from "./components/TimelineDialog";
import { useClipShortcuts } from "./interactions/clipShortcuts";
import { ClipInspector } from "./panels/ClipInspector";
import { ClipSide } from "./panels/ClipSide";
import { ExportDialog } from "./panels/ExportDialog";
import { PreviewStage } from "./panels/PreviewStage";
import { TimelineArea } from "./panels/TimelineArea";
import { useTransport } from "./preview/transport";
import { initialTimelineId, useClipStore } from "./stores/clipStore";
import { useExportStore } from "./stores/exportStore";
import { useStageSplit } from "./stores/stageSplit";

/**
 * The cutting room.
 *
 * A page of its own beside the board rather than a corner of it: a project is
 * cut here, the material its boards made lies on the left, and the two pages
 * stand under the same bar and the same corner menu so stepping between them
 * is stepping between rooms of one workshop rather than between applications.
 *
 * The room holds no document of its own. Which timeline is being looked at is
 * a reader's place (clipStore, remembered on this machine), and everything
 * that changes a cut goes through the command pipeline — entering a room and
 * moving between its timelines pushes history seams, so undoing here never
 * reaches back onto a board.
 */
export function ClipPage() {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const activeTimelineId = useClipStore((state) => state.activeTimelineId);
  const newTimelineOpen = useClipStore((state) => state.newTimelineOpen);
  const leftWidth = usePanelWidths((state) => state.left);
  const rightWidth = usePanelWidths((state) => state.right);
  // A column folded away is not rendered at all, and the corner it stood in
  // keeps the triangle that brings it back — the same two columns as the
  // canvas, with the same widths and the same folds.
  const leftFolded = usePanelFolds((state) => state.left);
  const rightFolded = usePanelFolds((state) => state.right);
  const previewShare = useStageSplit((state) => state.share);
  const exportOpen = useExportStore((state) => state.open);
  const projectId = moka?.metadata.id ?? null;
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // The room's keys live exactly as long as the room does, and a dialog that
  // is standing — the new-timeline question, or this list itself — keeps its
  // own keys: what it answers is not also answered behind it.
  useClipShortcuts({
    isBlocked: () =>
      shortcutsOpen ||
      useClipStore.getState().newTimelineOpen ||
      useExportStore.getState().open,
    onShowHelp: () => setShortcutsOpen(true),
  });

  // The clock and the sound live exactly as long as the room does: a room
  // nobody is standing in must not keep playing a cut behind them.
  useTransport();

  // Entering the room is a seam in the history: the board's undos stop at the
  // door, and what is undone here is not undone on a canvas. Which timeline
  // the room opens onto is the one this machine left the project on, falling
  // back to the first the document holds.
  useEffect(() => {
    if (!projectId) return;
    const opened = useProjectStore.getState().moka;
    if (!opened) return;
    useClipStore.getState().setActiveTimeline(initialTimelineId(opened));
    // The seam is a moment rather than a render, so its words are read where
    // it is made rather than taken from the render's own language.
    historyBoundary(i18n.t("clip:page.historyBoundary"));
  }, [projectId]);

  // A timeline the document no longer holds — deleted here, or by an undo of
  // the command that made it — is not what the room can be looking at: the
  // first timeline takes its place, and a document with none clears it.
  useEffect(() => {
    const timelines = moka?.timelines ?? [];
    const active = useClipStore.getState().activeTimelineId;
    if (timelines.some((timeline) => timeline.id === active)) return;
    useClipStore.getState().setActiveTimeline(timelines[0]?.id ?? null);
  }, [moka]);

  /**
   * Going home from here puts the project down first.
   *
   * There is no dialog about unsaved work on this page, since nothing on it
   * can leave work unsaved: what the room holds when the reader steps over
   * is flushed, and a flush that cannot land says so and keeps the reader
   * here rather than walking away from the work.
   */
  const goHome = async () => {
    const project = useProjectStore.getState();
    if (project.moka) {
      try {
        await project.flush();
      } catch {
        // The flush's own error is on the store; the toast says the rest.
      }
      const after = useProjectStore.getState();
      if (after.pending.length > 0 || after.saveStatus === "conflicted") {
        useAppStore
          .getState()
          .pushToast(
            "error",
            after.saveStatus === "conflicted"
              ? t("clip:page.saveConflict")
              : (after.saveError ?? t("clip:page.saveFailed")),
          );
        return;
      }
      after.close();
      useRunStore.getState().reset();
    }
    useAppStore.getState().setPhase("launcher");
  };

  const timelines = moka?.timelines ?? [];
  const activeTimeline =
    timelines.find((timeline) => timeline.id === activeTimelineId) ?? null;

  return (
    <div className="clip-page" data-testid="clip-page">
      <ClipTopBar onHome={() => void goHome()} />
      <div className="clip-body" style={panelWidthStyle(leftWidth, rightWidth)}>
        {leftFolded ? <PanelUnfold side="left" /> : <ClipSide />}
        {!leftFolded && <PanelResizer side="left" />}
        <main
          className="clip-stage"
          // The share the splitter was dragged to, read by the preview's own
          // stylesheet: the two panes divide the room they are given rather
          // than being told how tall the window is.
          style={
            { "--clip-preview-share": String(previewShare) } as CSSProperties
          }
        >
          {timelines.length === 0 ? (
            // A project without a timeline is a project with nowhere to cut:
            // the room offers the one thing there is to do rather than opening
            // onto a preview and a track area with nothing behind either.
            <div className="clip-empty clip-empty-first">
              <TimelineIcon size={30} />
              <h2>{t("clip:page.emptyTitle")}</h2>
              <p>{t("clip:page.emptyHint")}</p>
              <button
                className="primary"
                onClick={() => useClipStore.getState().setNewTimelineOpen(true)}
                type="button"
              >
                {t("clip:page.newTimeline")}
              </button>
            </div>
          ) : (
            <>
              <PreviewStage timeline={activeTimeline} />
              <StageSplit />
              <TimelineArea timeline={activeTimeline} />
            </>
          )}
        </main>
        {!rightFolded && <PanelResizer side="right" />}
        {rightFolded ? <PanelUnfold side="right" /> : <ClipInspector />}
      </div>
      {newTimelineOpen && <TimelineDialog />}
      {exportOpen && <ExportDialog />}
      {/* The project's shelf, reached from the cut's own column: choosing
          files here lands them on the open cut rather than anywhere else. */}
      <AssetPickerModal />
      {shortcutsOpen && (
        <ClipShortcutsDialog onClose={() => setShortcutsOpen(false)} />
      )}
    </div>
  );
}
