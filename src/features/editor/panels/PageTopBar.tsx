import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useModelStore } from "../../settings/modelStore";
import { redo, undo } from "../commands/execute";
import { useHistoryStore, isBoundary } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";
import { HomeMenu } from "../components/HomeMenu";

export const SAVE_LABEL: Record<string, string> = {
  saved: "editor:topBar.saved",
  saving: "editor:topBar.saving",
  conflicted: "editor:topBar.conflicted",
  error: "editor:topBar.saveFailed",
};

export function useCanUndo(): boolean {
  return useHistoryStore((state) => {
    const top = state.undoStack[state.undoStack.length - 1];
    return top !== undefined && !isBoundary(top);
  });
}

interface PageTopBarProps {
  /** The page the bar stands on, which the menu marks as current. */
  current: "canvas" | "clip" | "story" | "assets";
  /** What going home costs; the page decides whether that is guarded. */
  onHome: () => void;
  /** The middle of the bar: what the page is made of. */
  tabs?: ReactNode;
  /**
   * The answers under the Export button, which differs by page. A page with
   * none — the files room — keeps the button standing in the corner every page
   * wears one in, grayed, rather than opening a menu with nothing in it.
   */
  exportItems?: ReactNode;
}

/**
 * The bar every working page stands under.
 *
 * What the project is, where it is being saved, and the things that act on the
 * document as a whole. Everything that acts on one node lives on the node, in
 * its inspector, or in the menus the page itself offers, so this bar says the
 * same thing however much is selected — and the two exports, which answer one
 * question between them ("what should leave with this?"), are one button with
 * its answers under it rather than two buttons side by side.
 *
 * The middle and the menu are slots because that is what changes between the
 * canvases and the cutting room: the rest is one bar serving both pages, and a
 * reader stepping between them finds the same corner in the same place — even
 * on a page that fills neither slot, like the files room.
 */
export function PageTopBar({
  current,
  onHome,
  tabs,
  exportItems,
}: PageTopBarProps) {
  const { t } = useTranslation();
  const projectName = useProjectStore((state) => state.moka?.metadata.name);
  const saveStatus = useProjectStore((state) => state.saveStatus);
  const saveError = useProjectStore((state) => state.saveError);
  const canUndo = useCanUndo();
  const canRedo = useHistoryStore((state) => state.redoStack.length > 0);
  /** Whether this page has anything to put under the Export button. */
  const hasExports = Boolean(exportItems);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!exportRef.current?.contains(event.target as Node)) {
        setExportOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExportOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [exportOpen]);

  return (
    <header className="editor-topbar">
      <HomeMenu current={current} onHome={onHome} />
      <strong className="editor-project-name" title={projectName}>
        {projectName}
      </strong>
      {tabs}
      <span
        className={`save-status save-status-${saveStatus}`}
        title={saveError ?? undefined}
      >
        {t(SAVE_LABEL[saveStatus])}
      </span>
      {saveStatus === "conflicted" && (
        <button
          onClick={() =>
            void useProjectStore.getState().reload({ discardPending: true })
          }
          type="button"
        >
          {t("editor:topBar.reload")}
        </button>
      )}
      <div
        aria-label={t("editor:topBar.edit")}
        className="tool-group"
        role="group"
      >
        <button
          aria-label={t("editor:topBar.undo")}
          disabled={!canUndo}
          onClick={() => undo()}
          type="button"
        >
          ↶
        </button>
        <button
          aria-label={t("editor:topBar.redo")}
          disabled={!canRedo}
          onClick={() => redo()}
          type="button"
        >
          ↷
        </button>
      </div>
      <button
        onClick={() => useModelStore.getState().openSettings()}
        type="button"
      >
        {t("editor:topBar.settings")}
      </button>
      <div className="export-menu" ref={exportRef}>
        <button
          aria-expanded={hasExports ? exportOpen : undefined}
          aria-haspopup={hasExports ? "menu" : undefined}
          data-testid="export-menu-button"
          disabled={!hasExports}
          onClick={() => setExportOpen((seen) => !seen)}
          title={hasExports ? undefined : t("editor:topBar.exportNothing")}
          type="button"
        >
          {t("editor:topBar.export")}
        </button>
        {hasExports && exportOpen && (
          <div
            aria-label={t("editor:topBar.export")}
            className="menu export-menu-pop"
            data-testid="export-menu"
            // A choice made under this button puts the menu down with it; a
            // disabled answer never gets here, so the menu stays up for the
            // reader to see what it says.
            onClick={() => setExportOpen(false)}
            role="menu"
          >
            {exportItems}
          </div>
        )}
      </div>
    </header>
  );
}
