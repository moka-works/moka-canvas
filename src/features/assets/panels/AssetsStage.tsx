import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ASSET_CATEGORY_LABELS,
  ASSET_KIND_LABELS,
  MAX_ASSET_NAME_LENGTH,
  findResource,
  type ResourceEntry,
} from "../../../shared/domain";
import { assetUrl } from "../../../api";
import { AssetPreviewSection } from "../../editor/panels/AssetFacts";
import { kindOfShelf } from "../../editor/panels/shelfFilter";
import { shelfOf } from "../../editor/panels/canvasAssets";
import {
  editShelfEntry,
  markAssetKeeper,
  requestDeleteAsset,
  revealAsset,
} from "../../editor/interactions/actions";
import { useProjectStore } from "../../editor/stores/projectStore";
import { openUse } from "../goToHolder";
import { useAssetsStore } from "../stores/assetsStore";
import { assetUses, groupUses, type AssetUse, type UseRoom } from "../usage";
import { AssetsOverview } from "./AssetsOverview";

const ROOM_LABELS: Record<UseRoom, string> = {
  canvas: "assets:uses.canvas",
  clip: "assets:uses.clip",
  story: "assets:uses.story",
};

/** A use's own name among its siblings, for React's sake rather than reading. */
function holderKey(use: AssetUse): string {
  const holder = use.holder;
  switch (holder.kind) {
    case "node":
      return `node:${holder.canvasId}:${holder.nodeId}`;
    case "clip":
      return `clip:${holder.timelineId}:${holder.clipId}`;
    case "storyFile":
      return `story:${holder.storyId}:file`;
    case "drawing":
    case "drawingInUse":
      return `story:${holder.storyId}:${JSON.stringify(holder.target)}`;
    case "voiceReference":
      return `story:${holder.storyId}:voice:${holder.elementId ?? "narrator"}`;
  }
}

/**
 * The stage: the file that is chosen, and everything that points at it.
 *
 * A reader who picked a file on the column gets it big — what it looks like,
 * what can be done about it, and every place in the project that holds it,
 * each one a door to the room it lives in. While nothing is chosen the stage
 * reads the project itself instead.
 */
export function AssetsStage() {
  const moka = useProjectStore((state) => state.moka);
  const inspectedAssetId = useAssetsStore((state) => state.inspectedAssetId);
  const entry =
    moka && inspectedAssetId ? findResource(moka, inspectedAssetId) : undefined;

  // A file the project no longer holds is put down rather than left on the
  // stage: a delete, or the undo of the making, takes the file out from under
  // the reading, and an answer about nothing is not an answer.
  useEffect(() => {
    if (inspectedAssetId && !entry) {
      useAssetsStore.getState().select(null);
    }
  }, [inspectedAssetId, entry]);

  return entry ? <ChosenFile entry={entry} /> : <AssetsOverview />;
}

function ChosenFile({ entry }: { entry: ResourceEntry }) {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const uses = useMemo(
    () => (moka ? assetUses(moka, entry.id) : []),
    [moka, entry.id],
  );
  const groups = groupUses(uses);
  const keeper = entry.favorite === true;
  const shelf = shelfOf(entry);
  const chips = shelf
    ? [
        t(ASSET_CATEGORY_LABELS[shelf]),
        t(ASSET_KIND_LABELS[kindOfShelf(shelf)]),
      ]
    : [];

  return (
    <div className="assets-chosen" data-testid="assets-stage-file">
      <header className="assets-stage-head">
        <NameHeading entry={entry} key={entry.id} />
        <span className="assets-stage-chips">
          {chips.map((chip) => (
            <span className="assets-chip" key={chip}>
              {chip}
            </span>
          ))}
        </span>
        <div className="assets-stage-actions">
          <button
            aria-label={
              keeper
                ? t("editor:shelf.stopKeepingAria", { name: entry.name })
                : t("editor:shelf.keepAria", { name: entry.name })
            }
            aria-pressed={keeper}
            className={`resource-action keeper${keeper ? " is-active" : ""}`}
            onClick={() => void markAssetKeeper(entry, !keeper)}
            title={
              keeper
                ? t("editor:shelf.keptHint")
                : t("editor:shelf.notKeptHint")
            }
            type="button"
          >
            ★
          </button>
          <button onClick={() => void revealAsset(entry.id)} type="button">
            {t("editor:action.reveal")}
          </button>
          <a download={entry.name} href={assetUrl(entry.id)}>
            {t("editor:action.download")}
          </a>
          <button
            className="danger"
            onClick={() => void requestDeleteAsset(entry.id)}
            type="button"
          >
            {t("editor:action.remove")}
          </button>
        </div>
      </header>
      <div className="assets-preview">
        <AssetPreviewSection entry={entry} />
      </div>
      <section className="assets-uses">
        <h3>{t("assets:uses.heading")}</h3>
        {groups.length === 0 ? (
          <p className="assets-uses-none" data-testid="assets-uses-none">
            {t("assets:uses.none")}
          </p>
        ) : (
          groups.map((group) => (
            <div
              className="assets-use-group"
              data-testid={`assets-uses-${group.room}`}
              key={group.room}
            >
              <h4>{t(ROOM_LABELS[group.room])}</h4>
              <ul className="assets-use-list">
                {group.uses.map((use) => (
                  <li
                    className={`assets-use-row${use.blocking ? " is-blocking" : ""}`}
                    key={holderKey(use)}
                  >
                    <span className="assets-use-title" title={use.title}>
                      {use.title}
                    </span>
                    {use.oldDrawing && (
                      <span className="assets-use-old">
                        {t("assets:uses.oldTake")}
                      </span>
                    )}
                    <button
                      aria-label={t("assets:uses.openAria", {
                        title: use.title,
                      })}
                      className="assets-use-open"
                      onClick={() => openUse(use)}
                      type="button"
                    >
                      {t("assets:uses.open")}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

/**
 * The file's name, read large and written where it stands.
 *
 * A name is how a reader finds the file again when a card asks for a
 * reference, so it is theirs to change after the file has arrived. The bytes
 * underneath keep the path they were filed under — everything that points at
 * the file does so by id — and the write lands as a new revision the way
 * every other shelf edit does.
 */
function NameHeading({ entry }: { entry: ResourceEntry }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.name);
  // Escape takes the field back before it loses focus; without this the blur
  // that follows would write the abandoned words down as a rename.
  const cancelled = useRef(false);

  const start = () => {
    cancelled.current = false;
    setDraft(entry.name);
    setEditing(true);
  };

  const finish = () => {
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(entry.name);
      return;
    }
    const name = draft.trim();
    if (!name || name === entry.name) {
      setDraft(entry.name);
      return;
    }
    void editShelfEntry(entry, { name });
  };

  if (!editing) {
    return (
      <h2 className="assets-stage-name" title={entry.path}>
        {entry.name}
        <button
          aria-label={t("assets:stage.renameAria", { name: entry.name })}
          className="assets-stage-rename-open"
          onClick={start}
          title={t("assets:stage.rename")}
          type="button"
        >
          ✎
        </button>
      </h2>
    );
  }

  return (
    <form
      className="assets-stage-rename"
      onSubmit={(event) => {
        event.preventDefault();
        finish();
      }}
    >
      <input
        aria-label={t("assets:stage.nameAria")}
        autoFocus
        maxLength={MAX_ASSET_NAME_LENGTH}
        onBlur={finish}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            cancelled.current = true;
            event.currentTarget.blur();
          }
        }}
        value={draft}
      />
    </form>
  );
}
