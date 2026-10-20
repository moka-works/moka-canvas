import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isApiError, projectsApi } from "../../api";
import { unreferencedAssets, type MokaFile } from "../../shared/domain";
import { CanvasSurface } from "./canvas/CanvasSurface";
import { clientToWorld, zoomReset, zoomTo } from "./canvas/canvasControl";
import {
  ASSET_DRAG_MIME,
  addAssetNode,
  dropFileOnNode,
  fileDropTargetAt,
  fitSelectionAction,
  fitViewAction,
  importFiles,
} from "./interactions/actions";
import { useEditorKeyboard } from "./interactions/keyboard";
import { askSavePath, fileSafeName } from "./launcher/savePath";
import { useAppStore } from "./stores/appStore";
import { useEditorStore, useEffectiveTool } from "./stores/editorStore";
import { usePanelFolds } from "./stores/panelFolds";
import { usePanelWidths } from "./stores/panelWidths";
import { useActiveCanvas, useProjectStore } from "./stores/projectStore";
import { useRunStore, useRunsInFlight } from "./stores/runStore";
import { ContextMenu } from "./panels/ContextMenu";
import { NodeMenu } from "./panels/NodeMenu";
import { RightPanel } from "./panels/RightPanel";
import { SidePanel } from "./panels/SidePanel";
import { TopBar } from "./panels/TopBar";
import { AssetDeleteDialog } from "./components/AssetDeleteDialog";
import { AssetPickerModal } from "./components/AssetPickerModal";
import { AssetPreviewDialog } from "./components/AssetPreviewDialog";
import {
  UnsavedWorkDialog,
  type CloseAction,
} from "./components/UnsavedWorkDialog";
import { ExportBlockedDialog } from "./components/ExportBlockedDialog";
import {
  EXPORT_DEFAULTS,
  ExportDialog,
  type ExportChoices,
  type LeftBehind,
} from "./components/ExportDialog";
import { PanelUnfold } from "./components/PanelFold";
import { PanelResizer } from "./components/PanelResizer";
import { panelWidthStyle } from "./components/panelWidthVars";
import { RenameOverlay } from "./components/RenameOverlay";
import { TextEditOverlay } from "./components/TextEditOverlay";
import {
  ArrowIcon,
  FitIcon,
  HandIcon,
  SelectionIcon,
} from "./components/ToolIcons";
import { ExtensionPanel } from "./components/ExtensionPanel";
import { PromptPanel } from "./components/PromptPanel";
import { RunHint } from "./components/RunHint";
import { NodeActionBar } from "./components/NodeActionBar";
import { SelectionActionBar } from "./components/SelectionActionBar";
import { VideoCardOverlays } from "./components/VideoCardOverlays";
import { DirectorCardOverlay } from "../director/panels/DirectorCardOverlay";
import { DescribeDialog } from "./components/DescribeDialog";
import { PictureToolDialog } from "./components/PictureToolDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { RepaintDialog } from "./components/RepaintDialog";

/** What a package asked to carry only the placed assets would leave behind. */
function countLeftBehind(moka: MokaFile | null): LeftBehind {
  if (!moka) return { count: 0, bytes: 0 };
  const shelf = unreferencedAssets(moka);
  return {
    count: shelf.length,
    bytes: shelf.reduce((total, entry) => total + (entry.bytes ?? 0), 0),
  };
}

export function EditorPage() {
  const { t } = useTranslation();
  const saveStatus = useProjectStore((state) => state.saveStatus);
  const activeCanvas = useActiveCanvas();
  const liveZoom = useEditorStore((state) => state.camera?.zoom);
  const selectedCount = useEditorStore(
    (state) => state.selection.nodeIds.length,
  );
  const tool = useEffectiveTool();
  const leftWidth = usePanelWidths((state) => state.left);
  const rightWidth = usePanelWidths((state) => state.right);
  // A column folded away is not rendered at all, and the corner it stood in
  // keeps the triangle that brings it back: the canvas takes the whole row.
  const leftFolded = usePanelFolds((state) => state.left);
  const rightFolded = usePanelFolds((state) => state.right);
  const announcement = useEditorStore((state) => state.announcement);
  const inFlight = useRunsInFlight();
  useEditorKeyboard();

  useEffect(() => {
    void useRunStore.getState().load();
  }, []);

  const zoom = liveZoom ?? activeCanvas?.viewport.zoom ?? 1;

  const [exportBlock, setExportBlock] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportChoices, setExportChoices] =
    useState<ExportChoices>(EXPORT_DEFAULTS);
  // Where the package is going, asked once per export: a refusal that offers
  // to carry on anyway must not ask for the path a second time.
  const [exportDestination, setExportDestination] = useState<string | null>(
    null,
  );
  const [leftBehind, setLeftBehind] = useState<LeftBehind>({
    count: 0,
    bytes: 0,
  });
  const [exportThenClose, setExportThenClose] = useState(false);
  const [closeGuardOpen, setCloseGuardOpen] = useState(false);
  const [closeBusy, setCloseBusy] = useState<CloseAction | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const pendingCount = useProjectStore((state) => state.pending.length);

  // Read when the question is asked rather than watched: what is on offer is
  // the document as it stands at that moment, and numbers that move while a
  // dialog is being read are numbers to read again.
  const askAboutExport = (thenClose: boolean) => {
    setLeftBehind(countLeftBehind(useProjectStore.getState().moka));
    setExportDestination(null);
    setExportThenClose(thenClose);
    setExportOpen(true);
  };

  const finishClose = () => {
    useProjectStore.getState().close();
    useRunStore.getState().reset();
    useAppStore.getState().setPhase("launcher");
  };

  const requestClose = () => {
    const project = useProjectStore.getState();
    const guarded =
      project.pending.length > 0 ||
      project.saveStatus === "saving" ||
      project.saveStatus === "conflicted" ||
      inFlight > 0;
    if (!guarded) {
      finishClose();
      return;
    }
    setCloseError(null);
    setCloseGuardOpen(true);
  };

  const closeWith = async (action: CloseAction) => {
    if (action === "discard") {
      setCloseGuardOpen(false);
      finishClose();
      return;
    }
    setCloseBusy(action);
    setCloseError(null);
    const project = useProjectStore.getState();
    // A conflict blocks flushing; export then preserves the last saved revision.
    if (project.saveStatus !== "conflicted") {
      await project.flush();
      const after = useProjectStore.getState();
      if (after.pending.length > 0 || after.saveStatus === "conflicted") {
        setCloseBusy(null);
        setCloseError(
          after.saveStatus === "conflicted"
            ? t("editor:page.saveConflict")
            : (after.saveError ?? t("editor:page.saveFailed")),
        );
        return;
      }
    }
    if (action === "export") {
      setCloseBusy(null);
      setCloseGuardOpen(false);
      askAboutExport(true);
      return;
    }
    setCloseBusy(null);
    setCloseGuardOpen(false);
    finishClose();
  };

  const exportPackage = async (
    choices: ExportChoices,
    allowIncomplete = false,
  ) => {
    setExportChoices(choices);
    // Asked before anything is made, and answered once: the export that says
    // the placed assets are missing offers to carry on, and the path a reader
    // chose is the path that export takes.
    let destination = exportDestination;
    if (destination === null) {
      const name = useProjectStore.getState().moka?.metadata.name ?? "";
      destination = await askSavePath({
        title: t("editor:dialogs.exportPackage.saveTitle"),
        defaultName: `${fileSafeName(name)}.mokapkg.zip`,
        extensions: ["zip"],
      });
      if (destination === null) return;
      setExportDestination(destination);
    }
    setExportBusy(true);
    try {
      const report = await projectsApi.exportPackage({
        destination,
        allowIncomplete: allowIncomplete || undefined,
        includePersonalHistory: choices.includePersonalHistory || undefined,
        onlyReferencedAssets: choices.onlyReferencedAssets || undefined,
      });
      setExportBlock(null);
      setExportOpen(false);
      useAppStore.getState().pushToast(
        "success",
        report.incomplete
          ? t("editor:page.exportedIncomplete", {
              count: report.entries,
              destination: report.destination,
            })
          : t("editor:page.exported", {
              count: report.entries,
              destination: report.destination,
            }),
      );
      if (exportThenClose) finishClose();
    } catch (error) {
      if (!allowIncomplete && isApiError(error, "ASSET_MISSING")) {
        setExportOpen(false);
        setExportBlock(error.message);
      } else {
        setExportBlock(null);
        useAppStore
          .getState()
          .pushToast(
            "error",
            error instanceof Error
              ? error.message
              : t("editor:page.exportFailed"),
          );
      }
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <div className="editor">
      <div aria-live="polite" className="sr-only" role="status">
        {announcement}
      </div>
      <TopBar onBack={requestClose} onExport={() => askAboutExport(false)} />

      <div
        className="editor-body"
        style={panelWidthStyle(leftWidth, rightWidth)}
      >
        {leftFolded ? <PanelUnfold side="left" /> : <SidePanel />}
        {!leftFolded && <PanelResizer side="left" />}
        <main
          className="editor-canvas"
          data-testid="canvas-host"
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(event) => {
            event.preventDefault();
            const world = clientToWorld({
              x: event.clientX,
              y: event.clientY,
            });
            const assetId = event.dataTransfer.getData(ASSET_DRAG_MIME);
            if (assetId) {
              void addAssetNode(assetId, world ?? undefined);
              return;
            }
            const files = [...event.dataTransfer.files];
            // One file over a node is that node's new asset; anything else is
            // the canvas taking what was dropped, as it always has.
            if (files.length === 1 && world) {
              const target = fileDropTargetAt(world);
              if (target) {
                void dropFileOnNode(target.id, files[0], world);
                return;
              }
            }
            if (files.length > 0) {
              void importFiles(files, {
                at: world ?? undefined,
                addNodes: true,
              });
            }
          }}
        >
          <CanvasSurface />
          <VideoCardOverlays />
          <DirectorCardOverlay />
          <NodeActionBar />
          <SelectionActionBar />
          <RenameOverlay />
          <TextEditOverlay />
          <PromptPanel />
          <ExtensionPanel />
          <RunHint />
          <p className="editor-canvas-hint">
            {activeCanvas
              ? t("editor:counts.nodesEdges", {
                  nodes: activeCanvas.nodes.length,
                  edges: activeCanvas.edges.length,
                })
              : t("editor:page.noCanvas")}
          </p>
        </main>
        {!rightFolded && <PanelResizer side="right" />}
        {rightFolded ? <PanelUnfold side="right" /> : <RightPanel />}
      </div>

      <ContextMenu />
      <NodeMenu />
      <AssetDeleteDialog />
      <AssetPickerModal />
      <AssetPreviewDialog />
      <PictureToolDialog />
      <RepaintDialog />
      <DescribeDialog />
      <ShortcutsDialog />
      {exportOpen && (
        <ExportDialog
          busy={exportBusy}
          leftBehind={leftBehind}
          onCancel={() => setExportOpen(false)}
          onExport={(choices) => void exportPackage(choices)}
        />
      )}
      {exportBlock !== null && (
        <ExportBlockedDialog
          busy={exportBusy}
          message={exportBlock}
          onCancel={() => setExportBlock(null)}
          onExportAnyway={() => void exportPackage(exportChoices, true)}
        />
      )}
      {closeGuardOpen && (
        <UnsavedWorkDialog
          busy={closeBusy}
          error={closeError}
          inFlight={inFlight}
          onAction={(action) => void closeWith(action)}
          onCancel={() => setCloseGuardOpen(false)}
          pendingCount={pendingCount}
          saveStatus={saveStatus}
        />
      )}

      <footer className="editor-toolstrip">
        {/* One switch with two ends rather than two buttons to press: the
            thumb slides to the tool being held, and each end says what it is
            with the mark of the thing it does. */}
        <div
          aria-label={t("editor:page.toolGroup")}
          className="tool-switch"
          role="group"
        >
          <span
            aria-hidden="true"
            className="tool-switch-thumb"
            data-tool={tool}
          />
          <button
            aria-label={t("editor:page.selectTool")}
            aria-pressed={tool === "select"}
            className={tool === "select" ? "is-active" : ""}
            data-testid="tool-select"
            onClick={() => useEditorStore.getState().setTool("select")}
            title={t("editor:page.selectToolHint")}
            type="button"
          >
            <ArrowIcon />
          </button>
          <button
            aria-label={t("editor:page.panTool")}
            aria-pressed={tool === "pan"}
            className={tool === "pan" ? "is-active" : ""}
            data-testid="tool-pan"
            onClick={() => useEditorStore.getState().setTool("pan")}
            title={t("editor:page.panToolHint")}
            type="button"
          >
            <HandIcon />
          </button>
        </div>
        <div
          aria-label={t("editor:page.zoomGroup")}
          className="tool-group"
          role="group"
        >
          <button
            aria-label={t("editor:page.fitView")}
            data-testid="zoom-fit"
            onClick={() => fitViewAction()}
            title={t("editor:page.fitViewHint")}
            type="button"
          >
            <FitIcon />
          </button>
          <button
            aria-label={t("editor:page.zoomToSelection")}
            data-testid="zoom-selection"
            disabled={selectedCount === 0}
            onClick={() => fitSelectionAction()}
            title={t("editor:page.zoomToSelectionHint")}
            type="button"
          >
            <SelectionIcon />
          </button>
          <button
            aria-label={t("editor:page.zoomTo100")}
            onClick={() => zoomReset()}
            type="button"
          >
            100%
          </button>
          <input
            aria-label={t("editor:page.zoomGroup")}
            className="zoom-slider"
            max={500}
            min={5}
            onChange={(event) => zoomTo(Number(event.target.value) / 100)}
            step={5}
            type="range"
            value={Math.round(zoom * 100)}
          />
          <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
        </div>
      </footer>
    </div>
  );
}
