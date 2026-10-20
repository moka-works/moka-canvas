import { useTranslation } from "react-i18next";
import { exportCanvasImage } from "../interactions/actions";
import { useActiveCanvas } from "../stores/projectStore";
import { CanvasTabs } from "./CanvasTabs";
import { DirectorTab } from "./DirectorTab";
import { PageTopBar } from "./PageTopBar";

interface TopBarProps {
  onBack: () => void;
  /** Opens the export question; the dialog itself belongs to the page. */
  onExport: () => void;
}

/**
 * The canvas page's bar: the shared one with the board strip and the two
 * exports this page offers.
 *
 * The strips and the exports are arguments rather than neighbours so the bar
 * itself stays one thing: the cutting room stands under the same bar with a
 * strip of its own and one export, and neither page has to know how the other
 * is arranged.
 */
export function TopBar({ onBack, onExport }: TopBarProps) {
  const { t } = useTranslation();
  const canvasDoc = useActiveCanvas();

  return (
    <PageTopBar
      current="canvas"
      onHome={onBack}
      exportItems={
        <>
          <button
            onClick={onExport}
            role="menuitem"
            title={t("editor:topBar.exportProjectHint")}
            type="button"
          >
            {t("editor:topBar.exportProject")}
          </button>
          <button
            disabled={!canvasDoc || canvasDoc.nodes.length === 0}
            onClick={() => void exportCanvasImage()}
            role="menuitem"
            title={t("editor:topBar.exportImageHint")}
            type="button"
          >
            {t("editor:topBar.exportImage")}
          </button>
        </>
      }
      tabs={
        <>
          <CanvasTabs />
          <DirectorTab />
        </>
      }
    />
  );
}
