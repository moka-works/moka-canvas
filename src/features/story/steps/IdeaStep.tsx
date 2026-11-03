import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { assetsApi } from "../../../api";
import {
  ASPECT_LABELS,
  MAX_CHAPTER_MS,
  MAX_TOTAL_DURATION_MS,
  MIN_CHAPTER_MS,
  MIN_TOTAL_DURATION_MS,
  STORY_ASPECTS,
  STORY_IDEA_MAX,
  STORY_SOURCE_TEXT_MAX,
  defaultChapterCount,
  formatDuration,
  timelineSizeForAspect,
  type StoryAspect,
  type StoryBriefPatch,
  type StoryDocument,
} from "../../../shared/domain";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { useAppStore } from "../../editor/stores/appStore";
import { saveTrouble, useProjectStore } from "../../editor/stores/projectStore";
import { StepConfirm } from "../components/StepConfirm";
import { readTextAsset } from "../readText";

/** What a manuscript may be, and how big it may be. */
const ACCEPTED_TEXT = /\.(txt|md|markdown)$/i;
const SUGGESTED_TEXT = ".txt,.md,.markdown,text/plain,text/markdown";
const STORY_SOURCE_BYTES_MAX = 8 * 1024 * 1024;

/** How much of a manuscript the "start from the opening" button lifts. */
const OPENING_CHARS = 800;

/** The chapter lengths a reader can pick from, in minutes. */
const DURATION_PRESETS = [1, 3, 5, 10, 30];

/** The shortest running time the minute stepper can stand on. */
const MIN_TOTAL_MINUTES = Math.ceil(MIN_TOTAL_DURATION_MS / 60_000);

/**
 * The genres and looks offered as chips. The words a story is told and drawn
 * in are content rather than interface: they travel into prompts and come back
 * in the film, so they are written as a reader would write them rather than
 * translated.
 */
const GENRE_PRESETS = ["对白剧情", "动作", "悬疑", "喜剧", "纪录", "家庭"];
const STYLE_PRESETS = [
  "现代都市风",
  "古装国风",
  "日式动画",
  "写实电影",
  "水彩手绘",
  "赛博朋克",
];

function toast(kind: "info" | "error", message: string): void {
  useAppStore.getState().pushToast(kind, message);
}

/**
 * The premise a telling starts from, and the four things every step after this
 * one is written with: how long it runs, in what frame, in what genre and in
 * what look.
 *
 * The words are written into the document when the reader steps away from the
 * box rather than on every keystroke — an undo should take back a sentence, not
 * a letter — while the four settings are written as they are clicked, since a
 * click is already a whole answer.
 *
 * Nothing is generated here. How many chapters the premise becomes is a
 * question the next step asks, and a story that was split into chapters before
 * its reader had a say is a story told the wrong length.
 */
export function IdeaStep({ story }: { story: StoryDocument }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"write" | "upload">("write");
  const { draft, setDraft, commit } = useIdeaDraft(story);
  const [sourceText, setSourceText] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const brief = story.brief;
  const sourceId = brief.sourceAssetId;
  const sourceEntry = useProjectStore((state) =>
    (state.moka?.resources.texts ?? []).find((entry) => entry.id === sourceId),
  );
  const size = timelineSizeForAspect(brief.aspect);

  const writeBrief = (patch: Parameters<typeof patchBrief>[1]) => {
    patchBrief(story.id, patch);
  };

  /** Reads the manuscript back, once per session, for a count or a preview. */
  const needSource = async (): Promise<string | null> => {
    if (sourceId === undefined) return null;
    if (sourceText !== null) return sourceText;
    try {
      const text = await readTextAsset(sourceId);
      setSourceText(text);
      return text;
    } catch (problem) {
      toast(
        "error",
        problem instanceof Error ? problem.message : String(problem),
      );
      return null;
    }
  };

  const take = async (file: File) => {
    if (!ACCEPTED_TEXT.test(file.name)) {
      toast("error", t("story:idea.badType"));
      return;
    }
    if (file.size > STORY_SOURCE_BYTES_MAX) {
      toast("error", t("story:idea.tooBig"));
      return;
    }
    setUploading(true);
    try {
      // Filing a manuscript writes to the document on the server, so anything
      // still on its way there goes first: a pending premise saved afterwards
      // would be refused for resting on a revision the upload has replaced.
      await useProjectStore.getState().flush();
      if (useProjectStore.getState().pending.length > 0) {
        const blocked = saveTrouble();
        useAppStore
          .getState()
          .pushToast("error", blocked.message, undefined, blocked.detail);
        return;
      }
      const filed = await assetsApi.upload(file, { categoryHint: "texts" });
      useProjectStore.getState().integrateAssetEntry(filed.entry, {
        revision: filed.revision,
        updatedAt: filed.updatedAt,
      });
      const text = await readTextAsset(filed.entry.id);
      if (text.length > STORY_SOURCE_TEXT_MAX) {
        toast("error", t("story:idea.tooLong"));
        setUploading(false);
        return;
      }
      setSourceText(text);
      writeBrief({
        sourceAssetId: filed.entry.id,
        sourceName: filed.entry.name,
      });
    } catch (problem) {
      toast(
        "error",
        problem instanceof Error ? problem.message : String(problem),
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="story-step-scroll" data-testid="story-step-idea-body">
      <div className="story-step-wide">
        <p className="story-step-lead">{t("story:idea.lead")}</p>

        <div
          aria-label={t("story:idea.tabs")}
          className="story-tabs"
          role="tablist"
        >
          <button
            aria-selected={tab === "write"}
            className={`story-tab${tab === "write" ? " is-active" : ""}`}
            data-testid="story-idea-tab-write"
            onClick={() => setTab("write")}
            role="tab"
            type="button"
          >
            {t("story:idea.tabWrite")}
          </button>
          <button
            aria-selected={tab === "upload"}
            className={`story-tab${tab === "upload" ? " is-active" : ""}`}
            data-testid="story-idea-tab-upload"
            onClick={() => setTab("upload")}
            role="tab"
            type="button"
          >
            {t("story:idea.tabUpload")}
          </button>
        </div>

        {tab === "write" ? (
          <section className="story-idea-block">
            <textarea
              aria-label={t("story:idea.writeLabel")}
              className="story-idea-input"
              data-testid="story-idea-input"
              maxLength={STORY_IDEA_MAX}
              onBlur={commit}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("story:idea.writePlaceholder")}
              rows={10}
              value={draft}
            />
            <div className="story-idea-foot">
              {sourceId !== undefined && draft.trim() === "" && (
                <button
                  className="link"
                  data-testid="story-idea-lift"
                  onClick={() =>
                    void needSource().then((text) => {
                      if (text !== null) {
                        setDraft(text.slice(0, OPENING_CHARS));
                      }
                    })
                  }
                  type="button"
                >
                  {t("story:idea.liftOpening")}
                </button>
              )}
              <span
                className={countClass(draft.length)}
                data-testid="story-idea-count"
              >
                {draft.length} / {STORY_IDEA_MAX}
              </span>
            </div>
          </section>
        ) : (
          <section className="story-idea-block">
            {sourceId === undefined ? (
              <Dropzone busy={uploading} onFile={(file) => void take(file)} />
            ) : (
              <div className="story-source" data-testid="story-source">
                <div className="story-source-line">
                  <span className="story-source-name">
                    {brief.sourceName ?? t("story:idea.sourceUnnamed")}
                  </span>
                  <span className="story-source-size">
                    {sourceText !== null
                      ? t("story:idea.sourceChars", {
                          count: sourceText.length,
                        })
                      : sourceEntry?.bytes !== undefined
                        ? t("story:idea.sourceBytes", {
                            count: formatBytes(sourceEntry.bytes),
                          })
                        : t("story:idea.sourceUnread")}
                  </span>
                  <button
                    className="link"
                    data-testid="story-source-peek-toggle"
                    onClick={() => {
                      if (sourceText !== null) {
                        setPreviewing(!previewing);
                        return;
                      }
                      void needSource().then(() => setPreviewing(true));
                    }}
                    type="button"
                  >
                    {previewing
                      ? t("story:idea.hidePreview")
                      : t("story:idea.showPreview")}
                  </button>
                  <button
                    className="link"
                    data-testid="story-source-remove"
                    onClick={() => {
                      setSourceText(null);
                      setPreviewing(false);
                      writeBrief({
                        sourceAssetId: null,
                        sourceName: null,
                        sourceSplit: null,
                      });
                    }}
                    type="button"
                  >
                    {t("story:idea.removeSource")}
                  </button>
                </div>
                {previewing && sourceText !== null && (
                  <p
                    className="story-source-peek"
                    data-testid="story-source-peek"
                  >
                    {sourceText.slice(0, 200)}
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        <DurationRow
          chapterMs={brief.chapterMs}
          onChapterChange={(ms) => writeBrief({ chapterMs: ms })}
          onChange={(ms) => writeBrief({ totalDurationMs: ms })}
          totalMs={brief.totalDurationMs}
        />
        <div className="story-field">
          <span className="story-field-label">{t("story:idea.aspect")}</span>
          <div className="story-chips">
            {STORY_ASPECTS.map((aspect) => (
              <button
                aria-pressed={brief.aspect === aspect}
                className={`story-choice${
                  brief.aspect === aspect ? " is-on" : ""
                }`}
                data-testid={`story-idea-aspect-${aspect}`}
                key={aspect}
                onClick={() => writeBrief({ aspect })}
                type="button"
              >
                <AspectGlyph aspect={aspect} />
                <span>{t(ASPECT_LABELS[aspect])}</span>
              </button>
            ))}
          </div>
          <p className="story-hint" data-testid="story-idea-aspect-hint">
            {t("story:idea.aspectHint", {
              width: size.width,
              height: size.height,
            })}
          </p>
        </div>
        <WordsRow
          hint={t("story:idea.genreHint")}
          label={t("story:idea.genre")}
          max={40}
          onWrite={(genre) => writeBrief({ genre })}
          presets={GENRE_PRESETS}
          testId="genre"
          value={brief.genre}
        />
        <WordsRow
          hint={t("story:idea.styleHint")}
          label={t("story:idea.style")}
          max={60}
          onWrite={(style) => writeBrief({ style })}
          presets={STYLE_PRESETS}
          testId="style"
          value={brief.style}
        />

        {story.chapters.length > 0 && (
          <p className="story-callout" role="status">
            {t("story:idea.afterOutline")}
          </p>
        )}

        <div className="story-step-bar">
          <span className="story-hint">
            {brief.genre.trim() === "" || brief.style.trim() === ""
              ? t("story:idea.styleHintMissing")
              : ""}
          </span>
          <StepConfirm prepare={commit} step="idea" story={story} />
        </div>
      </div>
    </div>
  );
}

function countClass(used: number): string {
  const near = used / STORY_IDEA_MAX >= 0.9;
  return `story-count${near ? (used >= STORY_IDEA_MAX ? " is-full" : " is-near") : ""}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** One setting written down, which is one step to undo. */
function patchBrief(storyId: string, patch: StoryBriefPatch): boolean {
  return (
    execute(i18n.t("story:history.brief"), [
      { type: "updateStoryBrief", storyId, patch },
    ]) !== null
  );
}

/**
 * The premise as a draft, and when it becomes the document's.
 *
 * A reader types whole paragraphs, and every keystroke going through the
 * command pipeline would make the undo stack a record of their typing. So the
 * box holds the words until the reader looks away from it, asks for the next
 * step, or leaves the step; what is written then is one step to undo.
 */
function useIdeaDraft(story: StoryDocument): {
  draft: string;
  setDraft: (value: string) => void;
  commit: () => void;
} {
  const storyId = story.id;
  const committed = story.brief.idea;
  const [draft, setDraft] = useState(committed);
  const held = useRef({ draft, committed });
  held.current = { draft, committed };

  // A story re-written from somewhere else — an undo, another window — is the
  // document's word, not the box's.
  useEffect(() => {
    setDraft(committed);
  }, [committed, storyId]);

  const commit = () => {
    const { draft: now, committed: was } = held.current;
    if (now === was) return;
    patchBrief(storyId, { idea: now });
  };

  // Leaving the step with words that were never written down would lose them
  // silently, which is the one thing a draft may not do.
  useEffect(() => {
    return () => {
      const { draft: now, committed: was } = held.current;
      if (now !== was) patchBrief(storyId, { idea: now });
    };
  }, [storyId]);

  return { draft, setDraft, commit };
}

function Dropzone({
  busy,
  onFile,
}: {
  busy: boolean;
  onFile: (file: File) => void;
}) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);
  return (
    <div
      className={`story-drop${over ? " is-over" : ""}`}
      data-testid="story-drop"
      onDragLeave={() => setOver(false)}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const file = event.dataTransfer.files[0];
        if (file) onFile(file);
      }}
    >
      <p>{busy ? t("story:idea.uploading") : t("story:idea.dropHere")}</p>
      <button
        className="link"
        data-testid="story-choose-file"
        onClick={() => picker.current?.click()}
        type="button"
      >
        {t("story:idea.chooseFile")}
      </button>
      <input
        accept={SUGGESTED_TEXT}
        className="story-file"
        data-testid="story-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = "";
        }}
        ref={picker}
        type="file"
      />
      <p className="story-hint">{t("story:idea.accepted")}</p>
    </div>
  );
}

/** A frame drawn to its own proportions, which is what the choice is about. */
function AspectGlyph({ aspect }: { aspect: StoryAspect }) {
  const [wide, tall] = aspect.split(":").map((part) => Number(part));
  const scale = 20 / Math.max(wide, tall);
  const width = wide * scale;
  const height = tall * scale;
  return (
    <svg
      aria-hidden="true"
      className="story-aspect-glyph"
      height={height + 4}
      viewBox={`0 0 ${width + 4} ${height + 4}`}
      width={width + 4}
    >
      <rect
        fill="none"
        height={height}
        rx={2}
        stroke="currentColor"
        width={width}
        x={2}
        y={2}
      />
    </svg>
  );
}

function DurationRow({
  totalMs,
  chapterMs,
  onChange,
  onChapterChange,
}: {
  totalMs: number;
  chapterMs: number;
  onChange: (ms: number) => void;
  onChapterChange: (ms: number) => void;
}) {
  const { t } = useTranslation();
  // The running time is entered in whole minutes, so a value that lands
  // between two of them is pulled onto the nearer one rather than kept.
  const clamp = (ms: number) =>
    Math.min(
      MAX_TOTAL_DURATION_MS,
      Math.max(MIN_TOTAL_MINUTES * 60_000, Math.round(ms / 60_000) * 60_000),
    );
  const clampChapter = (ms: number) =>
    Math.min(MAX_CHAPTER_MS, Math.max(MIN_CHAPTER_MS, ms));
  const minutes = Math.round(totalMs / 60_000);
  const chapterMinutes = Math.round((chapterMs / 60_000) * 10) / 10;
  const step = (by: number) => onChange(clamp(totalMs + by * 60_000));
  const stepChapter = (by: number) =>
    onChapterChange(clampChapter(chapterMs + by * 30_000));

  return (
    <>
      <div className="story-field">
        <span className="story-field-label">{t("story:idea.duration")}</span>
        <div className="story-duration">
          <div className="story-stepper">
            <button
              aria-label={t("story:idea.shorter")}
              onClick={() => step(-1)}
              type="button"
            >
              −
            </button>
            <input
              aria-label={t("story:idea.duration")}
              data-testid="story-idea-duration"
              max={MAX_TOTAL_DURATION_MS / 60_000}
              min={MIN_TOTAL_MINUTES}
              onChange={(event) => {
                const wanted = Number(event.target.value);
                if (Number.isFinite(wanted)) onChange(clamp(wanted * 60_000));
              }}
              step={1}
              type="number"
              value={minutes}
            />
            <span className="story-stepper-unit">
              {t("story:idea.minutes")}
            </span>
            <button
              aria-label={t("story:idea.longer")}
              onClick={() => step(1)}
              type="button"
            >
              +
            </button>
          </div>
          <div className="story-chips">
            {DURATION_PRESETS.map((preset) => (
              <button
                aria-pressed={minutes === preset}
                className={`story-choice${minutes === preset ? " is-on" : ""}`}
                data-testid={`story-idea-duration-${preset}`}
                key={preset}
                onClick={() => onChange(clamp(preset * 60_000))}
                type="button"
              >
                {t("story:idea.minutesCount", { count: preset })}
              </button>
            ))}
          </div>
        </div>
        <p className="story-hint" data-testid="story-idea-duration-hint">
          {t("story:idea.durationHint", {
            chapters: defaultChapterCount(totalMs, chapterMs),
            minutes: chapterMinutes,
            duration: formatDuration(totalMs),
          })}
        </p>
      </div>

      <div className="story-field">
        <span className="story-field-label">
          {t("story:idea.chapterLength")}
        </span>
        <div className="story-duration">
          <div className="story-stepper">
            <button
              aria-label={t("story:idea.chapterShorter")}
              onClick={() => stepChapter(-1)}
              type="button"
            >
              −
            </button>
            <input
              aria-label={t("story:idea.chapterLength")}
              data-testid="story-idea-chapter-length"
              max={MAX_CHAPTER_MS / 60_000}
              min={MIN_CHAPTER_MS / 60_000}
              onChange={(event) => {
                const wanted = Number(event.target.value);
                if (Number.isFinite(wanted))
                  onChapterChange(clampChapter(wanted * 60_000));
              }}
              step={0.5}
              type="number"
              value={chapterMinutes}
            />
            <span className="story-stepper-unit">
              {t("story:idea.minutes")}
            </span>
            <button
              aria-label={t("story:idea.chapterLonger")}
              onClick={() => stepChapter(1)}
              type="button"
            >
              +
            </button>
          </div>
          <span className="story-hint">
            {t("story:idea.chapterLengthHint")}
          </span>
        </div>
      </div>
    </>
  );
}

function WordsRow({
  label,
  value,
  presets,
  max,
  hint,
  testId,
  onWrite,
}: {
  label: string;
  value: string;
  presets: string[];
  max: number;
  hint: string;
  testId: string;
  onWrite: (value: string) => void;
}) {
  return (
    <div className="story-field">
      <span className="story-field-label">{label}</span>
      <div className="story-chips">
        {presets.map((preset) => (
          <button
            aria-pressed={value === preset}
            className={`story-choice${value === preset ? " is-on" : ""}`}
            data-testid={`story-idea-${testId}-${preset}`}
            key={preset}
            onClick={() => onWrite(preset)}
            type="button"
          >
            {preset}
          </button>
        ))}
        <input
          aria-label={label}
          className="story-choice-input"
          data-testid={`story-idea-${testId}-input`}
          maxLength={max}
          onChange={(event) => onWrite(event.target.value)}
          placeholder="…"
          type="text"
          value={presets.includes(value) ? "" : value}
        />
      </div>
      <p className="story-hint">{hint}</p>
    </div>
  );
}
