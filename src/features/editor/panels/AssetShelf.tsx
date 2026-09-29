import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  AssetCategory,
  AssetId,
  AssetKind,
  MokaFile,
  NodeId,
  ResourceEntry,
} from "../../../shared/domain";
import {
  ASSET_CATEGORY_LABELS,
  ASSET_KIND_LABELS,
  PROJECT_ASSET_CATEGORIES,
  assetHolders,
} from "../../../shared/domain";
import { i18n } from "../../../shared/i18n";
import { assetThumbUrl } from "../../../api";
import { buildIssueIndex, formatBytes } from "../canvas/mediaCards";
import {
  ASSET_DRAG_MIME,
  editShelfEntry,
  focusAssetUses,
  focusNodes,
  importFiles,
  markAssetKeeper,
  requestDeleteAsset,
} from "../interactions/actions";
import { useEditorStore } from "../stores/editorStore";
import { useActiveCanvas, useProjectStore } from "../stores/projectStore";
import { canvasNodesUsing, makerOf, shelfOf } from "./canvasAssets";
import { unplacedEntries } from "./unplaced";
import {
  KIND_SHELVES,
  OPEN_SHELF_FILTER,
  SHELF_GLYPHS,
  SHELF_KINDS,
  SHELF_PAGE,
  SHELF_WHERE_LABELS,
  filterShelf,
  groupShelf,
  newestFirst,
  shelfFilterIsOpen,
  shelfTags,
  shelfWhere,
  type ShelfFilter,
  type ShelfLens,
  type ShelfWhere,
} from "./shelfFilter";

/**
 * The project's shelf of files, wherever it is read from.
 *
 * One shelf read by two pages rather than two shelves that agree: the canvas
 * column reads it whole, and the cutting room reads it through lenses — the
 * files brought in, and everything the project holds. Everything that makes
 * the shelf a shelf (the import and its jobs, the kind tabs, the search and
 * its words, the keepers, the rows with their drag-out and their words and
 * notes, the paging) lives here once; what a page differs on arrives as props.
 *
 * A row's contract for being dragged onto a timeline — `draggable`, an
 * `data-asset-id`, and an id written under `ASSET_DRAG_MIME` on dragstart — is
 * carried by the row itself and is the same on both pages.
 */

interface ImportJob {
  file: File;
  progress: number;
  status: "uploading" | "done" | "error";
}

export interface AssetShelfProps {
  /** The kind tabs offered; defaults to the editor's four. */
  kinds?: readonly AssetKind[];
  /** The question the face behind the shelf asks; not shown on the shelf. */
  lens?: ShelfLens;
  /** Within a group: filing order (default), or newest first. */
  order?: "filing" | "newest";
  /** The initial of "Add to canvas" for an import; the checkbox changes it. */
  addNodes?: boolean;
  /** Whether the "Add to canvas" checkbox appears at all. */
  showAddNodes?: boolean;
  /** Whether files dropped anywhere over the column are imported. */
  acceptFileDrops?: boolean;
  /** The kind being read, when the caller owns it; a tab writes it back. */
  kind?: AssetKind;
  onKindChange?: (kind: AssetKind) => void;
  /** The row being read: the inspector's file, or the material panel's. */
  selectedId?: AssetId | null;
  onSelect?: (id: AssetId) => void;
  /** The row a reader was just brought here to, from wherever. */
  focusedId?: AssetId | null;
  /** Told once the brought-here mark has been held long enough to be seen. */
  onFocusClear?: () => void;
  /** A page's own row actions, ahead of the shelf's own. */
  rowExtras?: (entry: ResourceEntry) => ReactNode;
  /** Whether the canvas-only offer (Focus) appears. */
  canvasActions?: boolean;
  /** What a face says when its shelf holds nothing; the editor has its own. */
  emptyText?: string;
  /** Told when an import has settled, so a face can turn where the files are. */
  onImported?: () => void;
  /**
   * The element around the shelf that a dropped file is taken anywhere over,
   * as a selector: the column the shelf sits in, which the page names.
   */
  dropScope?: string;
  /**
   * Files brought in and placed nowhere yet, offered above the shelf's list.
   *
   * The rows are the tray's own (the membership is read from the document) and
   * the action is the page's — a board's tray adds a card, a cut's tray lands
   * the file at the playhead — since what placing means is the page's to say.
   * The tray is not read through the face's lens: these files are exactly the
   * ones the lens excludes.
   */
  unplaced?: {
    /** The group's heading, as a translation key. */
    titleKey: string;
    /** The row's own offer, in place of the shelf's row extras. */
    action: (entry: ResourceEntry) => ReactNode;
  };
}

/** Selects the node a generated asset came from, wherever it sits. */
function focusGeneratingNode(nodeId: NodeId) {
  focusNodes([nodeId]);
  useEditorStore.getState().announce(i18n.t("editor:shelf.selectedMaker"));
}

/** How wide a row's picture is asked for: the row draws it 30–44 px tall. */
const ROW_THUMB_WIDTH = 320;

/** The picture a row leads with, when the file has one to show. */
function thumbOf(entry: ResourceEntry): string | null {
  if (entry.mime === "image/png" || entry.mime === "image/jpeg") {
    return assetThumbUrl(entry.id, ROW_THUMB_WIDTH);
  }
  const poster = entry.probe?.posterAssetId;
  return entry.mime === "video/mp4" && poster
    ? assetThumbUrl(poster, ROW_THUMB_WIDTH)
    : null;
}

/** The kind a shelf opens on: pictures, or the first kind a face has. */
function opensOn(kinds: readonly AssetKind[]): AssetKind {
  return kinds.includes("image") ? "image" : (kinds[0] ?? "image");
}

/** Whether an entry is on the shelf a lens reads. */
function onLens(entry: ResourceEntry, lens: ShelfLens): boolean {
  if (lens.where != null && shelfWhere(entry) !== lens.where) return false;
  return lens.narrow ? lens.narrow(entry) : true;
}

/** The files of one kind as a face reads them, in filing order. */
function kindEntries(
  moka: MokaFile,
  kind: AssetKind,
  lens?: ShelfLens,
): ResourceEntry[] {
  return KIND_SHELVES[kind].flatMap((shelf) => {
    const entries = moka.resources[shelf] ?? [];
    return lens ? entries.filter((entry) => onLens(entry, lens)) : [...entries];
  });
}

/** How many files a kind holds, for the tab that reads them.
 *
 * Counted over the whole of that kind rather than over what a filter left
 * standing, so a tab says what it has and not what is currently being asked of
 * it: a reader who narrowed the pictures to nothing still needs to know there
 * are pictures to narrow. Read through the face's lens, since a face that will
 * not show a file should not count it either.
 */
function kindCount(moka: MokaFile, kind: AssetKind, lens?: ShelfLens): number {
  return kindEntries(moka, kind, lens).length;
}

/**
 * The words an entry is filed under and whatever was noted about it, offered
 * right on the row. Only the registry entry is written, so adding a word costs
 * nothing of the file it names.
 */
function ShelfEditor({
  entry,
  onDone,
}: {
  entry: ResourceEntry;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [tags, setTags] = useState(() => (entry.tags ?? []).join(", "));
  const [note, setNote] = useState(entry.note ?? "");
  return (
    <form
      className="resource-editor"
      onSubmit={(event) => {
        event.preventDefault();
        const words = tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);
        void editShelfEntry(entry, {
          tags: [...new Set(words)],
          note: note.trim(),
        });
        onDone();
      }}
    >
      <input
        aria-label={t("editor:shelf.tagsFor", { name: entry.name })}
        className="resource-editor-tags"
        onChange={(event) => setTags(event.target.value)}
        placeholder={t("editor:shelf.tagsPlaceholder")}
        value={tags}
      />
      <textarea
        aria-label={t("editor:shelf.noteFor", { name: entry.name })}
        onChange={(event) => setNote(event.target.value)}
        placeholder={t("editor:shelf.notePlaceholder")}
        rows={2}
        value={note}
      />
      <div className="resource-editor-actions">
        <button type="submit">{t("editor:action.save")}</button>
        <button onClick={onDone} type="button">
          {t("editor:action.cancel")}
        </button>
      </div>
    </form>
  );
}

function ResourceRow({
  entry,
  broken,
  focused,
  inspected,
  usesHere,
  canvasActions,
  extraActions,
  onSelect,
}: {
  entry: ResourceEntry;
  broken: boolean;
  /** Whether a reader was just brought to this row from somewhere else. */
  focused: boolean;
  /** Whether this is the file the panel beside the shelf is reading. */
  inspected: boolean;
  /** The cards on the board being looked at that hold this file. */
  usesHere: NodeId[];
  /** Whether the canvas-only offers are asked for on this shelf. */
  canvasActions: boolean;
  /** A page's own row actions, rendered ahead of the shelf's own. */
  extraActions?: ReactNode;
  onSelect: (id: AssetId) => void;
}) {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const [editing, setEditing] = useState(false);
  const rowRef = useRef<HTMLLIElement | null>(null);
  // Followed here from elsewhere, which is a row among however many: brought
  // into view rather than left to be found somewhere below the fold. Asked of
  // the platform rather than assumed of it, since a column that cannot scroll
  // still marks the row a reader was taken to.
  useEffect(() => {
    const row = rowRef.current;
    if (focused && row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [focused]);
  // Every hold, not only the cards: a file a story keeps as a drawing is used
  // by the project as much as one a card shows, and a row reading "not used"
  // over a file the server refuses to delete is a row that lied.
  const uses = moka === null ? 0 : assetHolders(moka, entry.id).length;
  const maker = makerOf(moka, entry.provenance?.operationNodeId);
  const keeper = entry.favorite === true;
  const thumb = thumbOf(entry);
  const shelf = shelfOf(entry);
  const where = shelfWhere(entry);
  return (
    <li
      className={`resource-row${focused ? " is-focused" : ""}${
        inspected ? " is-inspected" : ""
      }`}
      data-asset-id={entry.id}
      draggable
      ref={rowRef}
      onDragStart={(event) => {
        event.dataTransfer.setData(ASSET_DRAG_MIME, entry.id);
        event.dataTransfer.effectAllowed = "copy";
      }}
      title={entry.path}
    >
      <span className="resource-thumb" data-testid="resource-thumb">
        {thumb ? (
          <img alt="" src={thumb} />
        ) : (
          <span aria-hidden="true">{shelf ? SHELF_GLYPHS[shelf] : "▪"}</span>
        )}
      </span>
      <button
        aria-pressed={inspected}
        className="resource-main"
        data-testid="resource-main"
        onClick={() => onSelect(entry.id)}
        title={t("editor:shelf.readInInspector")}
        type="button"
      >
        <strong>{entry.name}</strong>
        <span>
          {broken ? t("editor:shelf.broken") : ""}
          {formatBytes(entry.bytes)}
          {uses > 0
            ? uses === 1
              ? t("editor:counts.usesOne", { count: uses })
              : t("editor:counts.usesMany", { count: uses })
            : ""}
        </span>
      </button>
      <span className="resource-actions">
        {extraActions}
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
            keeper ? t("editor:shelf.keptHint") : t("editor:shelf.notKeptHint")
          }
          type="button"
        >
          ★
        </button>
        <button
          aria-label={t("editor:shelf.tagAria", { name: entry.name })}
          aria-pressed={editing}
          className={`resource-action${editing ? " is-active" : ""}`}
          onClick={() => setEditing((current) => !current)}
          title={t("editor:shelf.wordsAndNotes")}
          type="button"
        >
          {t("editor:action.tag")}
        </button>
        {/*
          The way to the cards rather than the way to the file: a reader who
          wants to stand on the board and look at what holds this file goes
          there on purpose. Greyed where this board holds none, since an offer
          that could only say "nothing here" is an offer better left unsaid —
          and the row already says how many cards in the project use it.
        */}
        {canvasActions && (
          <button
            aria-label={t("editor:shelf.focusUsing", { name: entry.name })}
            className="resource-action"
            disabled={usesHere.length === 0}
            onClick={() => focusAssetUses(usesHere)}
            title={
              usesHere.length === 0
                ? t("editor:shelf.noCardUsesIt")
                : usesHere.length === 1
                  ? t("editor:shelf.selectCardsOne")
                  : t("editor:shelf.selectCardsMany", {
                      count: usesHere.length,
                    })
            }
            type="button"
          >
            {t("editor:action.focus")}
          </button>
        )}
        <button
          aria-label={t("editor:shelf.deleteAria", { name: entry.name })}
          className="resource-action danger"
          onClick={() => void requestDeleteAsset(entry.id)}
          type="button"
        >
          ✕
        </button>
      </span>
      <span className="resource-said">
        <span className="resource-where" data-testid="resource-where">
          {t(SHELF_WHERE_LABELS[where])}
        </span>
        {entry.tags?.map((tag) => (
          <span className="resource-tag" key={tag}>
            {tag}
          </span>
        ))}
        {maker && (
          <button
            aria-label={t("editor:shelf.goToMaker", {
              maker: maker.title,
              name: entry.name,
            })}
            className="resource-origin"
            onClick={() => focusGeneratingNode(maker.id)}
            title={t("editor:shelf.madeBy", { title: maker.title })}
            type="button"
          >
            {t("editor:shelf.madeBy", { title: maker.title })}
          </button>
        )}
      </span>
      {editing && (
        <ShelfEditor entry={entry} onDone={() => setEditing(false)} />
      )}
    </li>
  );
}

function ShelfFilterBar({
  filter,
  words,
  shelves,
  whereLocked,
  onChange,
}: {
  filter: ShelfFilter;
  words: { tag: string; count: number }[];
  /** The shelves the kind being read is filed on, which is one for most kinds. */
  shelves: readonly AssetCategory[];
  /** Whether the origin question is already answered by the face. */
  whereLocked: boolean;
  onChange: (next: ShelfFilter) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="side-shelf-filter">
      <input
        aria-label={t("editor:shelf.searchShelf")}
        className="side-shelf-asked"
        data-testid="shelf-asked"
        onChange={(event) => onChange({ ...filter, asked: event.target.value })}
        placeholder={t("editor:shelf.searchPlaceholder")}
        type="search"
        value={filter.asked}
      />
      <div className="side-shelf-row">
        {/*
          Offered only where the kind has more than one shelf to tell apart:
          a sound is filed as either music or a voice, and a reader after one
          of them has a reason to say so. A kind filed on one shelf would be
          asking a question with one answer.
        */}
        {shelves.length > 1 && (
          <select
            aria-label={t("editor:shelf.whichShelf")}
            data-testid="shelf-category"
            onChange={(event) =>
              onChange({
                ...filter,
                category: (event.target.value ||
                  null) as ShelfFilter["category"],
              })
            }
            value={filter.category ?? ""}
          >
            <option value="">{t("editor:shelf.everyShelf")}</option>
            {shelves.map((category) => (
              <option key={category} value={category}>
                {t(ASSET_CATEGORY_LABELS[category])}
              </option>
            ))}
          </select>
        )}
        {/*
          The origin question is not offered where the face behind the shelf
          already answers it: Local is what was brought, and asking again on
          top of that could only empty the shelf. A face whose lens only
          narrows has not answered it and keeps the question.
        */}
        {!whereLocked && (
          <select
            aria-label={t("editor:shelf.whereFrom")}
            data-testid="shelf-where"
            onChange={(event) =>
              onChange({
                ...filter,
                where: (event.target.value || null) as ShelfWhere | null,
              })
            }
            value={filter.where ?? ""}
          >
            <option value="">{t("editor:shelf.anyOrigin")}</option>
            {(Object.keys(SHELF_WHERE_LABELS) as ShelfWhere[]).map((where) => (
              <option key={where} value={where}>
                {t(SHELF_WHERE_LABELS[where])}
              </option>
            ))}
          </select>
        )}
        <label className="side-shelf-keeper">
          <input
            checked={filter.keepersOnly}
            data-testid="shelf-keepers"
            onChange={(event) =>
              onChange({ ...filter, keepersOnly: event.target.checked })
            }
            type="checkbox"
          />
          {t("editor:shelf.keepersOnly")}
        </label>
        {!shelfFilterIsOpen(filter) && (
          <button
            data-testid="shelf-clear"
            onClick={() => onChange(OPEN_SHELF_FILTER)}
            type="button"
          >
            {t("editor:action.clear")}
          </button>
        )}
      </div>
      {words.length > 0 && (
        <div
          aria-label={t("editor:picker.filedUnder")}
          className="side-shelf-tags"
          role="group"
        >
          {words.map(({ count, tag }) => (
            <button
              aria-pressed={filter.tags.includes(tag)}
              className={`side-shelf-tag${
                filter.tags.includes(tag) ? " is-active" : ""
              }`}
              data-testid={`shelf-tag-${tag}`}
              key={tag}
              onClick={() =>
                onChange({
                  ...filter,
                  tags: filter.tags.includes(tag)
                    ? filter.tags.filter((seen) => seen !== tag)
                    : [...filter.tags, tag],
                })
              }
              type="button"
            >
              {tag} · {count}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AssetShelf({
  kinds = SHELF_KINDS,
  lens,
  order = "filing",
  addNodes = true,
  showAddNodes = true,
  acceptFileDrops = false,
  kind: controlledKind,
  onKindChange,
  selectedId = null,
  onSelect,
  focusedId = null,
  onFocusClear,
  rowExtras,
  canvasActions = true,
  emptyText,
  onImported,
  dropScope,
  unplaced,
}: AssetShelfProps) {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const selfCheck = useProjectStore((state) => state.selfCheck);
  const activeCanvas = useActiveCanvas();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const shelfRef = useRef<HTMLElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [ownKind, setOwnKind] = useState<AssetKind>(() => opensOn(kinds));
  const [addNodesToCanvas, setAddNodesToCanvas] = useState(addNodes);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [filter, setFilter] = useState<ShelfFilter>(OPEN_SHELF_FILTER);
  const [pages, setPages] = useState(1);
  const [dropping, setDropping] = useState(false);

  const kind =
    controlledKind && kinds.includes(controlledKind) ? controlledKind : ownKind;
  const issues = useMemo(() => buildIssueIndex(selfCheck), [selfCheck]);
  const held = useMemo(
    () => (moka ? kindEntries(moka, kind, lens) : []),
    [moka, kind, lens],
  );
  /** The shelves of the kind being read, holding nothing but what is on them. */
  const { resources, shelves } = useMemo(() => {
    const own = KIND_SHELVES[kind];
    const registry = Object.fromEntries(
      PROJECT_ASSET_CATEGORIES.map((category) => [
        category,
        own.includes(category)
          ? (moka?.resources[category] ?? []).filter((entry) =>
              lens ? onLens(entry, lens) : true,
            )
          : [],
      ]),
    ) as MokaFile["resources"];
    return { resources: registry, shelves: own };
  }, [moka, kind, lens]);
  const matched = useMemo(() => {
    const kept = filterShelf(resources, filter);
    return order === "newest" ? newestFirst(kept) : kept;
  }, [resources, filter, order]);
  /**
   * The tray: files brought in and placed nowhere yet, of the kind being read.
   *
   * Read outside the lens on purpose — a file waiting for a place is exactly
   * what a face about one document's files leaves out — and inside the
   * reader's own filter, so a search narrows the tray as it narrows the list.
   */
  const tray = useMemo(() => {
    if (!unplaced || !moka) return [];
    const waiting = unplacedEntries(moka, kind);
    if (waiting.length === 0) return [];
    const registry = Object.fromEntries(
      PROJECT_ASSET_CATEGORIES.map((category) => [
        category,
        waiting.filter((entry) => shelfOf(entry) === category),
      ]),
    ) as MokaFile["resources"];
    const kept = filterShelf(registry, filter);
    return order === "newest" ? newestFirst(kept) : kept;
  }, [unplaced, moka, kind, filter, order]);
  // Counted over the kind being read, so a word offered beside it is a word
  // that narrows this list rather than one that would empty it.
  const words = useMemo(() => shelfTags(resources), [resources]);
  useEffect(() => setPages(1), [filter, kind]);

  /**
   * Brings an asset followed here from somewhere else into view.
   *
   * Whatever was being asked of the shelf is let go of first: a row hidden by a
   * search is a row that cannot be scrolled to, and a reader who followed an
   * asset here is asking to see that asset rather than to keep a narrowing they
   * made for something else. The mark is taken off again a moment later, since
   * a row that stays lit forever is a row nobody reads as the one arrived at.
   */
  useEffect(() => {
    if (!focusedId) return;
    setFilter(OPEN_SHELF_FILTER);
    const opened = useProjectStore.getState().moka;
    if (opened) {
      const entries = kindEntries(opened, kind, lens);
      const ordered = order === "newest" ? newestFirst(entries) : entries;
      const at = ordered.findIndex((entry) => entry.id === focusedId);
      if (at >= 0) setPages(Math.ceil((at + 1) / SHELF_PAGE));
    }
    const timer = setTimeout(() => onFocusClear?.(), 2_500);
    return () => clearTimeout(timer);
  }, [focusedId, kind, lens, order, onFocusClear]);

  const startImport = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setJobs(
        files.map((file) => ({ file, progress: 0, status: "uploading" })),
      );
      await importFiles(files, {
        addNodes: addNodesToCanvas,
        signal: controller.signal,
        onFileProgress: (index, fraction) =>
          setJobs((current) =>
            current.map((job, i) =>
              i === index ? { ...job, progress: fraction } : job,
            ),
          ),
        onFileDone: (index, error) =>
          setJobs((current) =>
            current.map((job, i) =>
              i === index
                ? { ...job, progress: 1, status: error ? "error" : "done" }
                : job,
            ),
          ),
      });
      abortRef.current = null;
      setJobs((current) => {
        if (controller.signal.aborted) {
          return current.map((job) =>
            job.status === "uploading" ? { ...job, status: "error" } : job,
          );
        }
        return current.some((job) => job.status === "error") ? current : [];
      });
      if (!controller.signal.aborted) onImported?.();
    },
    [addNodesToCanvas, onImported],
  );

  const retryJob = (index: number) => {
    const job = jobs[index];
    if (!job) return;
    setJobs([]);
    void startImport([job.file]);
  };

  /**
   * A shelf that welcomes files takes them anywhere over the column it sits
   * in, not only over its own rows: a reader dragging a file in does not aim
   * at a scroll region. The listeners are native and on the document because
   * the column around the shelf is not the shelf's to bind — the page names
   * the region, and they are added only while a face asks for them, so a drop
   * meant for a board or a timeline is never taken by a shelf that was not
   * looking for one.
   */
  useEffect(() => {
    if (!acceptFileDrops) return;
    const column =
      shelfRef.current?.closest(dropScope ?? ".clip-column") ?? null;
    if (!column) return;
    const carryingFiles = (event: DragEvent) =>
      event.dataTransfer?.types.includes("Files") === true &&
      event.target instanceof Node &&
      column.contains(event.target);
    const over = (event: DragEvent) => {
      if (!carryingFiles(event)) return;
      // A refused drag never reports its files on drop: saying the column can
      // take them is what makes the drop arrive.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDropping(true);
    };
    const left = (event: DragEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && column.contains(next)) return;
      setDropping(false);
    };
    const drop = (event: DragEvent) => {
      if (!carryingFiles(event)) return;
      event.preventDefault();
      setDropping(false);
      void startImport([...(event.dataTransfer?.files ?? [])]);
    };
    const ended = () => setDropping(false);
    document.addEventListener("dragover", over);
    document.addEventListener("dragleave", left);
    document.addEventListener("drop", drop);
    document.addEventListener("dragend", ended);
    return () => {
      document.removeEventListener("dragover", over);
      document.removeEventListener("dragleave", left);
      document.removeEventListener("drop", drop);
      document.removeEventListener("dragend", ended);
    };
  }, [acceptFileDrops, dropScope, startImport]);

  if (!moka) return null;

  const busy = jobs.some((job) => job.status === "uploading");
  const filed = held.length;
  const visible = matched.slice(0, pages * SHELF_PAGE);

  const chooseKind = (next: AssetKind) => {
    setOwnKind(next);
    onKindChange?.(next);
  };

  return (
    <section className="side-resources" ref={shelfRef}>
      <div className="side-resources-head">
        {showAddNodes && (
          <label className="side-add-nodes">
            <input
              checked={addNodesToCanvas}
              onChange={(event) => setAddNodesToCanvas(event.target.checked)}
              type="checkbox"
            />
            {t("editor:shelf.addToCanvas")}
          </label>
        )}
        <button
          disabled={busy}
          onClick={() => fileInput.current?.click()}
          type="button"
        >
          {t("editor:shelf.import")}
        </button>
      </div>
      <div
        aria-label={t("editor:shelf.assetKind")}
        className="side-asset-kinds"
        role="tablist"
      >
        {kinds.map((each) => (
          <button
            aria-selected={each === kind}
            className={each === kind ? "is-active" : ""}
            data-testid={`asset-kind-${each}`}
            key={each}
            onClick={() => chooseKind(each)}
            role="tab"
            title={t("editor:shelf.addToNode", {
              kind: t(ASSET_KIND_LABELS[each]).toLowerCase(),
            })}
            type="button"
          >
            {t(ASSET_KIND_LABELS[each])}
            <span>{kindCount(moka, each, lens)}</span>
          </button>
        ))}
      </div>
      <input
        aria-label={t("editor:shelf.importFiles")}
        hidden
        multiple
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void startImport(files);
        }}
        ref={fileInput}
        type="file"
      />
      {jobs.length > 0 && (
        <ul className="side-import-jobs">
          {jobs.map((job, index) => (
            <li key={`${job.file.name}-${index}`}>
              <span className="side-import-name">{job.file.name}</span>
              {job.status === "uploading" ? (
                <>
                  <progress max={1} value={job.progress} />
                  <button
                    aria-label={t("editor:action.cancelImport")}
                    onClick={() => abortRef.current?.abort()}
                    type="button"
                  >
                    ✕
                  </button>
                </>
              ) : job.status === "error" ? (
                <>
                  <span className="side-import-error">
                    {t("editor:shelf.failed")}
                  </span>
                  <button onClick={() => retryJob(index)} type="button">
                    {t("editor:action.retry")}
                  </button>
                </>
              ) : (
                <span>{t("editor:shelf.done")}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <ShelfFilterBar
        filter={filter}
        onChange={setFilter}
        shelves={shelves}
        // Only a lens that says where files came from has answered the origin
        // question; one that merely narrows (a board's files, a cut's) leaves
        // it to the reader.
        whereLocked={lens?.where != null}
        words={words}
      />
      {filed > 0 && visible.length === 0 && (
        <p className="inspector-empty" data-testid="shelf-no-match">
          {t("editor:shelf.noMatch")}
        </p>
      )}
      {unplaced && tray.length > 0 && (
        <div
          className="side-resource-group side-resource-tray"
          data-testid="shelf-tray"
        >
          <h3>
            {t(unplaced.titleKey)} · {tray.length}
          </h3>
          <ul className="side-resource-list">
            {tray.map((entry) => (
              <ResourceRow
                broken={issues.has(entry.id)}
                canvasActions={canvasActions}
                entry={entry}
                extraActions={unplaced.action(entry)}
                focused={focusedId === entry.id}
                inspected={selectedId === entry.id}
                key={entry.id}
                onSelect={(id) => onSelect?.(id)}
                usesHere={
                  canvasActions && activeCanvas
                    ? canvasNodesUsing(activeCanvas, entry.id)
                    : []
                }
              />
            ))}
          </ul>
        </div>
      )}
      {groupShelf(visible).map(({ category, entries }) => (
        <div className="side-resource-group" key={category}>
          <h3>
            {t(ASSET_CATEGORY_LABELS[category])} · {entries.length}
          </h3>
          <ul className="side-resource-list">
            {entries.map((entry) => (
              <ResourceRow
                broken={issues.has(entry.id)}
                canvasActions={canvasActions}
                entry={entry}
                extraActions={rowExtras?.(entry)}
                focused={focusedId === entry.id}
                inspected={selectedId === entry.id}
                key={entry.id}
                onSelect={(id) => onSelect?.(id)}
                usesHere={
                  canvasActions && activeCanvas
                    ? canvasNodesUsing(activeCanvas, entry.id)
                    : []
                }
              />
            ))}
          </ul>
        </div>
      ))}
      {matched.length > visible.length && (
        <div className="side-shelf-paging">
          <span data-testid="shelf-shown">
            {t("editor:shelf.shown", {
              shown: visible.length,
              total: matched.length,
            })}
          </span>
          <button
            onClick={() => setPages((current) => current + 1)}
            type="button"
          >
            {t("editor:shelf.showMore", {
              count: Math.min(SHELF_PAGE, matched.length - visible.length),
            })}
          </button>
        </div>
      )}
      {filed === 0 && tray.length === 0 && (
        <p className="inspector-empty">
          {emptyText ??
            t("editor:shelf.empty", {
              kind: t(ASSET_KIND_LABELS[kind]).toLowerCase(),
            })}
        </p>
      )}
      {acceptFileDrops && dropping && (
        <div className="clip-media-drop">{t("editor:shelf.dropToImport")}</div>
      )}
    </section>
  );
}
