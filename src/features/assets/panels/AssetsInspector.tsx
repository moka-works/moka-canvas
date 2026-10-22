import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { findResource, type ResourceEntry } from "../../../shared/domain";
import { PanelFold } from "../../editor/components/PanelFold";
import { AgentDock } from "../../assistant/agent/AgentDock";
import {
  AssetFileSection,
  AssetProvenanceSection,
} from "../../editor/panels/AssetFacts";
import { buildResourceIndex } from "../../editor/canvas/mediaCards";
import { makerOf } from "../../editor/panels/canvasAssets";
import { editShelfEntry } from "../../editor/interactions/actions";
import { useProjectStore } from "../../editor/stores/projectStore";
import { openNode } from "../goToHolder";
import { useAssetsStore } from "../stores/assetsStore";

/**
 * The right column: what the chosen file is, what was said about it, and
 * where it came from.
 *
 * Facts are read; the words are written. The one writer is the action the
 * shelf's own row editor uses, so what is typed here lands in the document,
 * and in its revision, exactly as it does from a row — and the announcement
 * that follows is the shelf's own.
 */
export function AssetsInspector() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"details" | "assistant">("details");
  const moka = useProjectStore((state) => state.moka);
  const inspectedAssetId = useAssetsStore((state) => state.inspectedAssetId);
  const entry =
    moka && inspectedAssetId ? findResource(moka, inspectedAssetId) : undefined;
  const resources = useMemo(
    () => (moka ? buildResourceIndex(moka) : new Map()),
    [moka],
  );
  const maker = entry ? makerOf(moka, entry.provenance?.operationNodeId) : null;

  return (
    <aside
      aria-label={t("assets:inspector.label")}
      className="assets-inspector"
      id="assets-panel-right"
    >
      <PanelFold side="right" />
      <div className="side-panel-tabs" role="tablist">
        <button
          aria-selected={tab === "details"}
          className={tab === "details" ? "is-active" : ""}
          onClick={() => setTab("details")}
          role="tab"
          type="button"
        >
          {t("assets:inspector.label")}
        </button>
        <button
          aria-selected={tab === "assistant"}
          className={tab === "assistant" ? "is-active" : ""}
          onClick={() => setTab("assistant")}
          role="tab"
          type="button"
        >
          {t("agent:title")}
        </button>
      </div>
      {tab === "assistant" ? (
        <AgentDock room="assets" />
      ) : entry ? (
        <div className="inspector-asset" data-testid="assets-inspector-file">
          <h3 className="inspector-asset-name" title={entry.name}>
            {entry.name}
          </h3>
          <AssetFileSection entry={entry} />
          <WordsSection entry={entry} key={entry.id} />
          <AssetProvenanceSection
            entry={entry}
            makerLabel={
              maker
                ? t("editor:shelf.madeBy", { title: maker.title })
                : undefined
            }
            onOpenMaker={
              maker
                ? () => openNode(entry.provenance?.canvasId, maker.id)
                : undefined
            }
            resources={resources}
          />
        </div>
      ) : (
        <p className="inspector-empty">{t("assets:inspector.empty")}</p>
      )}
    </aside>
  );
}

/**
 * The words the file is filed under, written from here.
 *
 * Seeded per file rather than followed: a write lands back as a new revision
 * of the same file, and a section that re-seeded on that would take the words
 * out of the field being typed in. The caller keys this on the file's id, so
 * a reader turning to another file gets that file's own words — which is
 * exactly what `key` is for.
 */
function WordsSection({ entry }: { entry: ResourceEntry }) {
  const { t } = useTranslation();
  const [tags, setTags] = useState<string[]>(() => entry.tags ?? []);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState(entry.note ?? "");
  const [keyword, setKeyword] = useState(entry.keyword ?? "");

  const write = (edit: {
    tags?: string[];
    note?: string;
    keyword?: string;
  }): void => void editShelfEntry(entry, edit);

  const addWord = () => {
    const word = draft.trim();
    setDraft("");
    if (!word || tags.includes(word)) return;
    const next = [...tags, word];
    setTags(next);
    write({ tags: next });
  };

  const removeWord = (word: string) => {
    const next = tags.filter((tag) => tag !== word);
    setTags(next);
    write({ tags: next });
  };

  return (
    <section
      className="inspector-section assets-words"
      data-testid="assets-words"
    >
      <h3>{t("assets:words.heading")}</h3>
      <div className="assets-word-field">
        <span className="assets-word-label">{t("assets:words.tags")}</span>
        <div className="assets-word-tags">
          {tags.map((tag) => (
            <span className="assets-word-chip" key={tag}>
              {tag}
              <button
                aria-label={t("assets:words.removeAria", { word: tag })}
                className="assets-word-drop"
                onClick={() => removeWord(tag)}
                type="button"
              >
                ✕
              </button>
            </span>
          ))}
          <input
            aria-label={t("assets:words.add")}
            className="assets-word-add"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addWord();
              }
            }}
            placeholder={t("assets:words.add")}
            value={draft}
          />
        </div>
      </div>
      <label className="assets-word-field">
        <span className="assets-word-label">{t("assets:words.note")}</span>
        <textarea
          aria-label={t("assets:words.note")}
          onChange={(event) => setNote(event.target.value)}
          onBlur={() => {
            if (note.trim() !== (entry.note ?? ""))
              write({ note: note.trim() });
          }}
          rows={3}
          value={note}
        />
      </label>
      <label className="assets-word-field">
        <span className="assets-word-label">{t("assets:words.keyword")}</span>
        <input
          aria-label={t("assets:words.keyword")}
          onBlur={() => {
            if (keyword.trim() !== (entry.keyword ?? "")) {
              write({ keyword: keyword.trim() });
            }
          }}
          onChange={(event) => setKeyword(event.target.value)}
          value={keyword}
        />
      </label>
    </section>
  );
}
