import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ASSET_KIND_LABELS,
  allResources,
  collectAssetReferences,
  unreferencedAssets,
} from "../../../shared/domain";
import { PanelFold } from "../../editor/components/PanelFold";
import { AssetShelf } from "../../editor/panels/AssetShelf";
import { unheldLens } from "../../editor/panels/shelfFilter";
import { useProjectStore } from "../../editor/stores/projectStore";
import { ClearUnusedDialog } from "../components/ClearUnusedDialog";
import { useAssetsStore, type AssetsView } from "../stores/assetsStore";

/** The two questions the column can be asked: everything, or what is unused. */
const VIEWS: readonly AssetsView[] = ["all", "unused"];

const VIEW_LABELS: Record<AssetsView, string> = {
  all: "assets:view.all",
  unused: "assets:view.unused",
};

/**
 * The library column: every file the project holds, one kind at a time.
 *
 * The pane that finds a file — the kinds and their counts, the shelf's search
 * and its words, and the rows — with the stage beside it reading whichever
 * file is chosen. Nothing is placed from here: putting a file somewhere is
 * each room's own business, and a file nobody has placed yet is visible in
 * the unused view.
 */
export function AssetsColumn() {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const view = useAssetsStore((state) => state.view);
  const kind = useAssetsStore((state) => state.kind);
  const inspectedAssetId = useAssetsStore((state) => state.inspectedAssetId);
  const [clearing, setClearing] = useState(false);

  // What the unused view answers: the same pointing-at the delete guard reads,
  // gathered once per document rather than once per row. The same list is
  // what the sweep offers to take, so the confirmation and the button agree.
  const unused = useMemo(() => (moka ? unreferencedAssets(moka) : []), [moka]);
  const placed = useMemo(
    () => new Set(moka ? collectAssetReferences(moka).keys() : []),
    [moka],
  );

  // What each view of the column holds, for the two buttons that ask for it.
  const counts = useMemo(
    () => ({
      all: moka ? allResources(moka).length : 0,
      unused: unused.length,
    }),
    [moka, unused],
  );

  return (
    <aside
      aria-label={t("assets:page.title")}
      className="assets-column"
      id="assets-panel-left"
    >
      <PanelFold side="left" />
      <div className="assets-column-head">
        <h2>{t("assets:page.title")}</h2>
        <div
          aria-label={t("assets:view.label")}
          className="assets-view"
          role="group"
        >
          {VIEWS.map((option) => (
            <button
              aria-pressed={view === option}
              className={view === option ? "is-active" : undefined}
              data-testid={`assets-view-${option}`}
              key={option}
              onClick={() => useAssetsStore.getState().setView(option)}
              type="button"
            >
              {t(VIEW_LABELS[option])}
              <span className="assets-view-count">{counts[option]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="assets-column-scroll">
        <AssetShelf
          acceptFileDrops
          addNodes={false}
          canvasActions={false}
          dropScope=".assets-column"
          emptyText={
            view === "unused"
              ? t("assets:shelf.emptyUnused")
              : t("assets:shelf.empty", {
                  kind: t(ASSET_KIND_LABELS[kind]).toLowerCase(),
                })
          }
          headAction={
            view === "unused" ? (
              <button
                data-testid="assets-clear-unused"
                disabled={unused.length === 0}
                onClick={() => setClearing(true)}
                title={
                  unused.length === 0 ? t("assets:clear.nothing") : undefined
                }
                type="button"
              >
                {t("assets:clear.button")}
              </button>
            ) : undefined
          }
          kind={kind}
          lens={view === "unused" ? unheldLens(placed) : undefined}
          onKindChange={(next) => useAssetsStore.getState().setKind(next)}
          onSelect={(id) => useAssetsStore.getState().select(id)}
          selectedId={inspectedAssetId}
          showAddNodes={false}
        />
      </div>
      {clearing && (
        <ClearUnusedDialog
          entries={unused}
          onClose={() => setClearing(false)}
        />
      )}
    </aside>
  );
}
