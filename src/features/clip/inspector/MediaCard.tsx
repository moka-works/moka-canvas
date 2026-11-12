import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_ASSET_NOTE_LENGTH,
  MAX_ASSET_TAGS,
  MAX_ASSET_TAG_LENGTH,
  type AssetId,
  type ResourceEntry,
  type TimelineDocument,
} from "../../../shared/domain";
import { assetThumbUrl, assetUrl } from "../../../api";
import { formatBytes, formatDuration } from "../../editor/canvas/mediaCards";
import {
  editShelfEntry,
  markAssetKeeper,
  requestDeleteAsset,
} from "../../editor/interactions/actions";
import { StarIcon, TrashIcon } from "../components/ClipIcons";
import { addAssetAtPlayhead } from "../interactions/clipActions";
import {
  noteVideoPaused,
  noteVideoPlaying,
  previewKindOf,
  stopMediaPreview,
  stopMediaPreviewFor,
  useMediaPreview,
} from "../panels/mediaPreview";
import { useAssetWaveform } from "../timeline/decor";
import { downsample } from "../timeline/waveform";

/**
 * A file read on its own: what it is, and what can be done with it.
 *
 * The material card of the cutting room, and the same facts the shelf's own
 * inspector shows, said where a reader is already working: the size of the
 * picture, how long the sound runs, the words it is filed under, the star
 * that keeps it to hand, and the two things worth doing with it now — adding
 * it at the playhead and letting it go.
 *
 * The card leads with the file itself: a video plays here on its own
 * controls, following the shelf row's play mark and keeping it true, and a
 * sound draws its own shape where the picture would be.
 */

/** The still picture a file leads with, when the file is one. */
function stillUrl(entry: ResourceEntry): string | null {
  if (entry.mime === "image/png" || entry.mime === "image/jpeg")
    return assetUrl(entry.id);
  // A film leads with its own first frame; the server draws one where the
  // project has not kept it yet.
  return entry.mime?.startsWith("video/") ? assetThumbUrl(entry.id, 768) : null;
}

/**
 * A video, played where the card leads.
 *
 * The element is the card's own, but whose turn it is to play is not: the
 * row's play mark, the transport starting and another card arriving all move
 * the one preview state, and this element follows it — while its own
 * controls move the state back, so the row's mark stays true whichever side
 * asked. Leaving the card, or the file failing to play, puts the sound away.
 */
function PreviewVideo({ entry }: { entry: ResourceEntry }) {
  const elementRef = useRef<HTMLVideoElement | null>(null);
  const preview = useMediaPreview();
  const playing =
    preview.assetId === entry.id && preview.kind === "video" && preview.playing;

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    if (playing) {
      void element.play().catch(() => stopMediaPreview());
    } else {
      element.pause();
    }
  }, [playing, entry.id]);

  useEffect(() => () => stopMediaPreviewFor(entry.id), [entry.id]);

  return (
    <video
      className="clip-inspector-video"
      controls
      data-testid="clip-media-preview-video"
      onEnded={stopMediaPreview}
      onError={stopMediaPreview}
      onPause={() => noteVideoPaused(entry.id)}
      onPlay={() => noteVideoPlaying(entry.id)}
      poster={stillUrl(entry) ?? undefined}
      ref={elementRef}
      src={assetUrl(entry.id)}
    />
  );
}

/** How wide a sound's shape is drawn before the column scales it. */
const WAVEFORM_WIDTH = 480;
/** How tall the strip stands: the height the picture leads with. */
const WAVEFORM_HEIGHT = 120;

/**
 * A sound, drawn as the shape it is.
 *
 * The same buckets the timeline's blocks are drawn from, the whole file at
 * once rather than the span of a cut, since the card is where the file is met
 * rather than where a piece of it is trimmed. The ink is the canvas's own
 * colour from the stylesheet, so the strip follows the room's palette like any
 * text; a sound the browser will not decode draws as the flat line it will be
 * on the timeline.
 */
function WaveformStrip({ assetId }: { assetId: AssetId }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useAssetWaveform(assetId);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
    ctx.fillStyle = getComputedStyle(canvas).color;
    const centre = canvas.height / 2;
    const half = Math.max(1, canvas.height / 2 - 4);
    if (drawing?.kind === "flat") {
      ctx.globalAlpha = 0.5;
      ctx.fillRect(0, centre - 1, canvas.width, 2);
      return;
    }
    if (drawing?.kind !== "peaks") return;
    const columns = Math.max(1, Math.floor(canvas.width));
    const { min, max } = downsample(drawing.peaks, columns);
    for (let column = 0; column < columns; column += 1) {
      const low = centre - max[column] * half;
      const high = centre - min[column] * half;
      ctx.fillRect(column, low, 1, Math.max(1, high - low));
    }
  }, [drawing]);

  return (
    <canvas
      className="clip-inspector-waveform"
      data-testid="clip-media-preview-waveform"
      data-waveform={drawing?.kind ?? "measuring"}
      height={WAVEFORM_HEIGHT}
      ref={canvasRef}
      width={WAVEFORM_WIDTH}
    />
  );
}

export interface MediaCardProps {
  entry: ResourceEntry;
  /** The cut the file would land on, or null when the project has none. */
  timeline: TimelineDocument | null;
}
export function MediaCard({ entry, timeline }: MediaCardProps) {
  const { t } = useTranslation();
  const still = stillUrl(entry);
  const previewKind = previewKindOf(entry);
  const [tags, setTags] = useState(() => (entry.tags ?? []).join(", "));
  const [note, setNote] = useState(entry.note ?? "");
  const probe = entry.probe;

  useEffect(() => {
    setTags((entry.tags ?? []).join(", "));
    setNote(entry.note ?? "");
  }, [entry.id, entry.tags, entry.note]);

  const save = () => {
    const words = tags
      .split(",")
      .map((word) => word.trim())
      .filter((word) => word.length > 0 && word.length <= MAX_ASSET_TAG_LENGTH);
    void editShelfEntry(entry, {
      tags: [...new Set(words)].slice(0, MAX_ASSET_TAGS),
      note: note.slice(0, MAX_ASSET_NOTE_LENGTH).trim(),
    });
  };

  return (
    <div className="clip-inspector-body" data-testid="clip-media-card">
      <section className="inspector-section">
        <h3 className="inspector-asset-name">{entry.name}</h3>
        {previewKind === "video" ? (
          <PreviewVideo entry={entry} />
        ) : previewKind === "audio" ? (
          <WaveformStrip assetId={entry.id} />
        ) : (
          still !== null && (
            <img alt="" className="clip-inspector-still" src={still} />
          )
        )}
      </section>

      <section className="inspector-section">
        <h3>{t("clip:mediaCard.file")}</h3>
        {probe?.width !== undefined && probe.height !== undefined && (
          <div className="inspector-row">
            <span>{t("clip:mediaCard.size")}</span>
            <span>
              {probe.width} × {probe.height}
            </span>
          </div>
        )}
        {probe?.durationMs !== undefined && (
          <div className="inspector-row">
            <span>{t("clip:mediaCard.length")}</span>
            <span>{formatDuration(probe.durationMs)}</span>
          </div>
        )}
        {entry.bytes !== undefined && (
          <div className="inspector-row">
            <span>{t("clip:mediaCard.bytes")}</span>
            <span>{formatBytes(entry.bytes)}</span>
          </div>
        )}
        {(probe?.mime ?? entry.mime) !== undefined && (
          <div className="inspector-row">
            <span>{t("clip:mediaCard.format")}</span>
            <span>{probe?.mime ?? entry.mime}</span>
          </div>
        )}
        {probe?.codecSummary !== undefined && (
          <div className="inspector-row">
            <span>{t("clip:mediaCard.codec")}</span>
            <span>{probe.codecSummary}</span>
          </div>
        )}
      </section>

      <section className="inspector-section">
        <h3>{t("clip:mediaCard.words")}</h3>
        <label className="clip-inspector-field">
          <span>{t("clip:mediaCard.tags")}</span>
          <input
            onChange={(event) => setTags(event.target.value)}
            placeholder={t("clip:mediaCard.tagsHint")}
            value={tags}
          />
        </label>
        <label className="clip-inspector-field">
          <span>{t("clip:mediaCard.note")}</span>
          <textarea
            onChange={(event) => setNote(event.target.value)}
            placeholder={t("clip:mediaCard.noteHint")}
            rows={2}
            value={note}
          />
        </label>
        <button onClick={save} type="button">
          {t("clip:mediaCard.saveWords")}
        </button>
      </section>

      <section className="inspector-section">
        <h3>{t("clip:mediaCard.actions")}</h3>
        <div className="clip-inspector-actions">
          <button
            aria-label={t("clip:mediaCard.keeperAria")}
            aria-pressed={entry.favorite === true}
            className="clip-inspector-keeper"
            onClick={() => void markAssetKeeper(entry, entry.favorite !== true)}
            type="button"
          >
            <StarIcon filled={entry.favorite === true} size={14} />{" "}
            {t("clip:mediaCard.keeper")}
          </button>
          <button
            disabled={timeline === null}
            onClick={() => addAssetAtPlayhead(entry.id)}
            title={
              timeline === null
                ? t("clip:mediaCard.noTimeline")
                : t("clip:common.addAtPlayhead")
            }
            type="button"
          >
            {t("clip:common.addAtPlayhead")}
          </button>
          <button
            className="danger"
            onClick={() => void requestDeleteAsset(entry.id)}
            type="button"
          >
            <TrashIcon size={14} /> {t("clip:common.delete")}
          </button>
        </div>
      </section>
    </div>
  );
}
