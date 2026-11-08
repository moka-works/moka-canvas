import { useTranslation } from "react-i18next";
import {
  ASSET_KINDS,
  ASSET_KIND_LABELS,
  allResources,
  unreferencedAssets,
  type MokaFile,
} from "../../../shared/domain";
import { formatBytes } from "../../editor/canvas/mediaCards";
import { KIND_SHELVES } from "../../editor/panels/shelfFilter";
import { usePanelFolds } from "../../editor/stores/panelFolds";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useAssetsStore } from "../stores/assetsStore";

/**
 * What the room says before anything is chosen: the project's own shelf, one
 * line about it and a card per kind.
 *
 * The same reading the export's "only placed files" question is answered from
 * — what the project holds, what nothing points at — so arriving in the room
 * says what there is to look at rather than waiting to be asked, and the two
 * places a reader meets this count cannot disagree.
 */

/** How many files of each kind the project holds, and how much room they take. */
function kindSizes(
  moka: MokaFile,
): { kind: (typeof ASSET_KINDS)[number]; count: number; bytes: number }[] {
  return ASSET_KINDS.map((kind) => {
    const entries = KIND_SHELVES[kind].flatMap(
      (shelf) => moka.resources[shelf] ?? [],
    );
    return {
      kind,
      count: entries.length,
      bytes: entries.reduce(
        (total, entry) => total + (entry.bytes ?? entry.probe?.bytes ?? 0),
        0,
      ),
    };
  });
}

export function AssetsOverview() {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const kind = useAssetsStore((state) => state.kind);
  if (!moka) return null;

  const entries = allResources(moka);
  const unused = unreferencedAssets(moka).length;
  const used = entries.length - unused;
  const bytes = entries.reduce(
    (total, entry) => total + (entry.bytes ?? entry.probe?.bytes ?? 0),
    0,
  );
  const sizes = kindSizes(moka);

  // A card can be pressed with the column folded away, and a card that turned
  // something nobody can see would be a card that did nothing: what was asked
  // for is brought back into view rather than left behind the fold.
  const revealColumn = () => {
    const folds = usePanelFolds.getState();
    if (folds.left) folds.setFolded("left", false);
  };
  const line =
    entries.length === 1
      ? t("assets:overview.totalOne", {
          used,
          unused,
          bytes: formatBytes(bytes),
        })
      : t("assets:overview.totalMany", {
          files: entries.length,
          used,
          unused,
          bytes: formatBytes(bytes),
        });

  return (
    <div className="assets-overview" data-testid="assets-overview">
      <p className="assets-overview-total" data-testid="assets-overview-total">
        {line}
      </p>
      {unused > 0 && (
        <button
          className="assets-overview-unused"
          data-testid="assets-overview-unused"
          onClick={() => {
            useAssetsStore.getState().setView("unused");
            revealColumn();
          }}
          type="button"
        >
          {t("assets:overview.unusedLink", { count: unused })}
        </button>
      )}
      <div className="assets-overview-kinds">
        {sizes.map((size) => (
          <button
            aria-pressed={kind === size.kind}
            className="assets-overview-kind"
            data-testid={`assets-overview-${size.kind}`}
            key={size.kind}
            onClick={() => {
              // A kind is the whole shelf narrowed to it, not the kind inside
              // whichever question the column was last asked: pressing a card
              // answers "everything, this kind" rather than inheriting the view.
              useAssetsStore.getState().setKind(size.kind);
              useAssetsStore.getState().setView("all");
              revealColumn();
            }}
            type="button"
          >
            <strong>{t(ASSET_KIND_LABELS[size.kind])}</strong>
            <span>
              {size.count === 1
                ? t("assets:overview.kindOne", {
                    bytes: formatBytes(size.bytes),
                  })
                : t("assets:overview.kindMany", {
                    files: size.count,
                    bytes: formatBytes(size.bytes),
                  })}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
