import { useTranslation } from "react-i18next";
import { AgentDock } from "../../assistant/agent/AgentDock";
import { PanelFold } from "../components/PanelFold";
import { useEditorStore } from "../stores/editorStore";
import { HistoryPanel } from "./HistoryPanel";
import { InspectorPanel } from "./InspectorPanel";

/**
 * The column on the right of the canvas, and the choice of what it shows.
 *
 * Three faces of one column, turned over by the tabs at its head rather than
 * by buttons on a strip across the bottom of the window: what is chosen is
 * read here, so the choice is offered here. The column beside the canvas on
 * the other side works the same way, and the two sides of the canvas are
 * worked the same way because they are the same kind of thing — down to the
 * corner that folds the column away.
 */
export function RightPanel() {
  const { t } = useTranslation();
  const tab = useEditorStore((state) => state.sidePanelTab);
  const setTab = useEditorStore((state) => state.setSidePanelTab);

  return (
    <div className="editor-right" data-testid="right-panel" id="panel-right">
      <PanelFold side="right" />
      <div
        aria-label={t("editor:rightPanel.columnShows")}
        className="side-panel-tabs"
        role="tablist"
      >
        <button
          aria-selected={tab === "inspector"}
          className={tab === "inspector" ? "is-active" : ""}
          data-testid="right-tab-inspector"
          onClick={() => setTab("inspector")}
          role="tab"
          title={t("editor:rightPanel.inspectorHint")}
          type="button"
        >
          {t("editor:rightPanel.inspector")}
        </button>
        <button
          aria-selected={tab === "assistant"}
          className={tab === "assistant" ? "is-active" : ""}
          data-testid="right-tab-assistant"
          onClick={() => setTab("assistant")}
          role="tab"
          title={t("editor:rightPanel.assistantHint")}
          type="button"
        >
          {t("editor:rightPanel.assistant")}
        </button>
        <button
          aria-selected={tab === "history"}
          className={tab === "history" ? "is-active" : ""}
          data-testid="right-tab-history"
          onClick={() => setTab("history")}
          role="tab"
          title={t("editor:rightPanel.historyHint")}
          type="button"
        >
          {t("editor:rightPanel.history")}
        </button>
      </div>
      {tab === "assistant" ? (
        <AgentDock room="canvas" />
      ) : tab === "history" ? (
        <HistoryPanel />
      ) : (
        <InspectorPanel />
      )}
    </div>
  );
}
