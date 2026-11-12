import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { assetThumbUrl, assetUrl } from "../../../api";
import {
  ASSET_KIND_LABELS,
  PROJECT_ASSET_CATEGORIES,
  findNode,
  type AssetId,
  type AssetKind,
  type ResourceEntry,
} from "../../../shared/domain";
import {
  addAssetNodes,
  attachAssetsToNode,
  replaceNodeWithAsset,
} from "../interactions/actions";
import { addAssetsAtPlayhead } from "../../clip/interactions/clipActions";
import { useClampedMenuPosition } from "../panels/useClampedMenuPosition";
import {
  OPEN_SHELF_FILTER,
  SHELF_GLYPHS,
  SHELF_KINDS,
  filterShelf,
  kindOfShelf,
  shelfTags,
  type ShelfFilter,
} from "../panels/shelfFilter";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";

/** Which kind of thing a file is, read off the shelf it is filed on. */
function kindOf(entry: ResourceEntry): AssetKind {
  const shelf = entry.path.split("/")[1];
  const category = PROJECT_ASSET_CATEGORIES.find((name) => name === shelf);
  return kindOfShelf(category ?? "texts");
}

/**
 * The picture a row leads with, when the file has one to show.
 *
 * A moving picture shows the still that was taken of it, since a row cannot
 * play a shot; a file with nothing to show leads with the mark of its shelf.
 */
function thumbOf(entry: ResourceEntry): string | null {
  const mime = entry.mime ?? entry.probe?.mime ?? "";
  if (mime.startsWith("image/")) return assetUrl(entry.id);
  // A film leads with its own first frame, drawn by the server at the size
  // the row uses.
  return mime.startsWith("video/") ? assetThumbUrl(entry.id, 320) : null;
}

/** One row's taste of the file: its picture, or its words where it has none. */
function PickLead({
  entry,
  kind,
  glyph,
  thumb,
}: {
  entry: ResourceEntry;
  kind: AssetKind;
  glyph: string;
  thumb: string | null;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (thumb !== null && failed !== thumb) {
    return (
      <img
        alt=""
        className="asset-pick-thumb"
        onError={() => setFailed(thumb)}
        src={thumb}
      />
    );
  }
  return <RowWords entry={entry} glyph={glyph} kind={kind} />;
}

/**
 * The words a row leads with, where there is no picture to show.
 *
 * What a file carries about itself — the summary of the text it holds or the
 * ask it came from — is its thumbnail, cut short by the row rather than by
 * the file.
 */
function excerptOf(entry: ResourceEntry): string {
  return entry.keyword?.trim() || entry.note?.trim() || "";
}

/**
 * The words read out of text files, remembered per version of the file for as
 * long as the app is open: the shelf is asked about often and a file is read
 * once.
 */
const wordsCache = new Map<string, string>();

function cacheKeyOf(entry: ResourceEntry): string {
  return `${entry.id}@${entry.updatedAt}`;
}

/** How much of a file's words a row leads with. */
const ROW_WORDS = 160;
/** How much of a file's words the card a hover brings up reads, at most. */
const HOVER_WORDS = 4000;

/**
 * The card a hover over a row's words brings up, with the whole of what the
 * row leads with.
 *
 * Read out of a card of its own rather than the row: the list a picker shows
 * scrolls, and words belonging to one row must not be cut by the row's box or
 * pushed off the screen by the row's place in the list.
 */
function WordsCard({ words, x, y }: { words: string; x: number; y: number }) {
  const { ref, pos } = useClampedMenuPosition(x, y);
  return (
    <div
      className="asset-pick-words"
      data-testid="asset-pick-words"
      ref={ref}
      role="tooltip"
      style={{ left: pos.x, top: pos.y }}
    >
      {words}
    </div>
  );
}

/**
 * The words a row of the shelf leads with, for the two kinds that are made of
 * words: a text file is read out of itself (what the entry carries is a search
 * phrase, and a file a reader imported carries nothing at all), and a sound
 * leads with the ask it came from, since a sound holds no words to read.
 *
 * A hover over the words brings up a card with the whole of them, so a reader
 * choosing between two texts is choosing by what they say rather than by an
 * icon that looks the same on both.
 */
function RowWords({
  entry,
  kind,
  glyph,
}: {
  entry: ResourceEntry;
  kind: AssetKind;
  glyph: string;
}) {
  const [fetched, setFetched] = useState<string | null>(
    () => wordsCache.get(cacheKeyOf(entry)) ?? null,
  );
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const boxRef = useRef<HTMLSpanElement>(null);

  const cacheKey = cacheKeyOf(entry);
  useEffect(() => {
    if (kind !== "text") return;
    const held = wordsCache.get(cacheKey);
    if (held !== undefined) {
      setFetched(held);
      return;
    }
    let wanted = true;
    fetch(assetUrl(entry.id))
      .then((response) =>
        response.ok
          ? response.text()
          : Promise.reject(new Error(response.statusText)),
      )
      .then((body) => {
        const words = body.slice(0, HOVER_WORDS);
        wordsCache.set(cacheKey, words);
        if (wanted) setFetched(words);
      })
      .catch(() => {
        // A file that cannot be read leads with whatever the entry says about
        // it, which is what the row led with before the file was asked.
        if (wanted) setFetched(null);
      });
    return () => {
      wanted = false;
    };
  }, [entry.id, cacheKey, kind]);

  const words =
    kind === "text" ? fetched?.trim() || excerptOf(entry) : excerptOf(entry);
  const shown = words.slice(0, ROW_WORDS);

  return (
    <>
      <span
        className="asset-pick-excerpt"
        data-testid={`asset-pick-excerpt-${entry.id}`}
        onMouseEnter={() => {
          if (words === "") return;
          const rect = boxRef.current?.getBoundingClientRect();
          setAnchor({
            x: (rect?.right ?? 0) + 8,
            y: rect?.top ?? 0,
          });
        }}
        onMouseLeave={() => setAnchor(null)}
        ref={boxRef}
      >
        {shown || <span aria-hidden="true">{glyph}</span>}
      </span>
      {anchor !== null && <WordsCard words={words} x={anchor.x} y={anchor.y} />}
    </>
  );
}

/**
 * One question: which files off the shelf, and several may be answered at once.
 *
 * Two kinds of ask share one dialog, because the choosing is the same in both
 * and only what happens afterwards differs: what is chosen either becomes nodes
 * of its own, or is given to the node whose panel asked. What it will come to
 * is stated on the dialog before anything is taken, since a pick of ten files
 * is ten nodes or ten references and neither is obvious from the list alone.
 */
export function AssetPickerModal() {
  const { t } = useTranslation();
  const ask = useEditorStore((state) => state.assetPicker);
  const moka = useProjectStore((state) => state.moka);
  const activeCanvasId = useProjectStore((state) => state.activeCanvasId);
  const [filter, setFilter] = useState<ShelfFilter>(OPEN_SHELF_FILTER);
  const [chosen, setChosen] = useState<AssetId[]>([]);
  const [busy, setBusy] = useState(false);

  // Each opening starts clean: a dialog that kept the last answer's ticks would
  // add files nobody chose yet to whatever is asked of it now.
  useEffect(() => {
    if (!ask) return;
    setFilter(OPEN_SHELF_FILTER);
    setChosen([]);
  }, [ask]);

  useEffect(() => {
    if (!ask) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") useEditorStore.getState().closeAssetPicker();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ask]);

  // Where the ask is to swap the picture a node already holds, only files that
  // node can hold are offered: a picture filed under another kind would leave
  // the node holding something it is not.
  const replaceKind: AssetKind | null = useMemo(() => {
    if (!ask || ask.mode !== "replace" || !moka) return null;
    const canvas =
      moka.canvas.find((entry) => entry.id === activeCanvasId) ??
      moka.canvas[0];
    const node = canvas ? findNode(canvas, ask.nodeId) : undefined;
    switch (node?.kind) {
      case "image":
      case "audio":
      case "video":
      case "text":
        return node.kind;
      default:
        return null;
    }
  }, [ask, moka, activeCanvasId]);
  const entries = useMemo(() => {
    if (!moka) return [];
    const shown = filterShelf(moka.resources, filter);
    return replaceKind
      ? shown.filter((entry) => kindOf(entry) === replaceKind)
      : shown;
  }, [moka, filter, replaceKind]);
  const words = useMemo(() => (moka ? shelfTags(moka.resources) : []), [moka]);

  if (!ask) return null;

  const close = () => useEditorStore.getState().closeAssetPicker();
  // One picture takes a node's place, so a swap offers one answer at a time:
  // ticking another file moves the tick rather than adding to it.
  const toggle = (assetId: AssetId) =>
    setChosen((seen) => {
      if (ask.mode === "replace") {
        return seen.includes(assetId) ? [] : [assetId];
      }
      return seen.includes(assetId)
        ? seen.filter((id) => id !== assetId)
        : [...seen, assetId];
    });
  const take = async () => {
    setBusy(true);
    try {
      if (ask.mode === "nodes") {
        await addAssetNodes(chosen, ask.at ?? undefined);
      } else if (ask.mode === "reference") {
        await attachAssetsToNode(ask.nodeId, chosen);
      } else if (ask.mode === "replace") {
        const [first] = chosen;
        if (first) await replaceNodeWithAsset(ask.nodeId, first);
      } else {
        // Placing lands clips on the open cut, one after another from the
        // playhead; the room says what it did, so the dialog just closes.
        addAssetsAtPlayhead(chosen);
      }
      close();
    } finally {
      setBusy(false);
    }
  };

  const count =
    chosen.length === 0
      ? t("editor:picker.nothingChosen")
      : ask.mode === "nodes"
        ? t(
            chosen.length === 1
              ? "editor:picker.insertCountOne"
              : "editor:picker.insertCountMany",
            { count: chosen.length },
          )
        : ask.mode === "reference"
          ? t(
              chosen.length === 1
                ? "editor:picker.addCountOne"
                : "editor:picker.addCountMany",
              { count: chosen.length },
            )
          : ask.mode === "replace"
            ? t("editor:picker.replaceCount")
            : t(
                chosen.length === 1
                  ? "editor:picker.placeCountOne"
                  : "editor:picker.placeCountMany",
                { count: chosen.length },
              );
  const title =
    ask.mode === "nodes"
      ? t("editor:picker.insertTitle")
      : ask.mode === "reference"
        ? t("editor:picker.addTitle")
        : ask.mode === "replace"
          ? t("editor:picker.replaceTitle")
          : t("editor:picker.placeTitle");

  return (
    <div className="dialog-backdrop" onClick={close} role="presentation">
      <div
        aria-label={title}
        aria-modal="true"
        className="dialog asset-pick-dialog"
        data-testid="asset-picker"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="preview-dialog-head">
          <h2>{title}</h2>
          <button
            aria-label={t("editor:picker.close")}
            onClick={close}
            type="button"
          >
            ✕
          </button>
        </header>

        <div className="asset-pick-filter">
          <input
            aria-label={t("editor:picker.searchShelf")}
            data-testid="asset-pick-asked"
            onChange={(event) =>
              setFilter((seen) => ({ ...seen, asked: event.target.value }))
            }
            placeholder={t("editor:picker.searchPlaceholder")}
            type="search"
            value={filter.asked}
          />
          <select
            aria-label={t("editor:picker.whichKind")}
            data-testid="asset-pick-category"
            onChange={(event) =>
              setFilter((seen) => ({
                ...seen,
                kind: (event.target.value || null) as AssetKind | null,
              }))
            }
            value={filter.kind ?? ""}
          >
            <option value="">{t("editor:picker.everyKind")}</option>
            {SHELF_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(ASSET_KIND_LABELS[kind])}
              </option>
            ))}
          </select>
          {words.length > 0 && (
            <div
              aria-label={t("editor:picker.filedUnder")}
              className="side-shelf-tags"
              role="group"
            >
              {words.map(({ count: carried, tag }) => (
                <button
                  aria-pressed={filter.tags.includes(tag)}
                  className={`side-shelf-tag${
                    filter.tags.includes(tag) ? " is-active" : ""
                  }`}
                  data-testid={`asset-pick-tag-${tag}`}
                  key={tag}
                  onClick={() =>
                    setFilter((seen) => ({
                      ...seen,
                      tags: seen.tags.includes(tag)
                        ? seen.tags.filter((word) => word !== tag)
                        : [...seen.tags, tag],
                    }))
                  }
                  type="button"
                >
                  {tag} · {carried}
                </button>
              ))}
            </div>
          )}
        </div>

        {entries.length === 0 ? (
          <p className="prompt-panel-note" data-testid="asset-pick-none">
            {t("editor:picker.nothingMatches")}
          </p>
        ) : (
          <ul
            aria-label={t("editor:picker.filesOnShelf")}
            className="asset-pick-list"
          >
            {entries.map((entry) => {
              const kind = kindOf(entry);
              const thumb = thumbOf(entry);
              const shelf = PROJECT_ASSET_CATEGORIES.find(
                (name) => name === entry.path.split("/")[1],
              );
              return (
                <li key={entry.id}>
                  {/* One row, read in one direction: the tick that takes the
                      file, the kind it is, a taste of it — the picture for
                      what has one, the words for what does not — and its
                      name. */}
                  <label className="asset-pick-row">
                    <input
                      checked={chosen.includes(entry.id)}
                      className="asset-pick-tick"
                      data-testid={`asset-pick-${entry.id}`}
                      onChange={() => toggle(entry.id)}
                      type="checkbox"
                    />
                    <span
                      className={`asset-pick-kind is-${kind}`}
                      data-testid={`asset-pick-kind-${entry.id}`}
                    >
                      {t(ASSET_KIND_LABELS[kind])}
                    </span>
                    <PickLead
                      entry={entry}
                      glyph={shelf ? SHELF_GLYPHS[shelf] : "▪"}
                      kind={kind}
                      thumb={thumb}
                    />
                    <span className="asset-pick-name">{entry.name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <footer className="asset-pick-foot">
          <p className="prompt-panel-note" data-testid="asset-pick-count">
            {count}
          </p>
          <button onClick={close} type="button">
            {t("editor:action.cancel")}
          </button>
          <button
            className="primary"
            disabled={chosen.length === 0 || busy}
            onClick={() => void take()}
            type="button"
          >
            {busy
              ? t("editor:picker.working")
              : ask.mode === "nodes"
                ? t("editor:action.insert")
                : ask.mode === "reference"
                  ? t("editor:action.add")
                  : ask.mode === "replace"
                    ? t("editor:action.replace")
                    : t("editor:action.place")}
          </button>
        </footer>
      </div>
    </div>
  );
}
