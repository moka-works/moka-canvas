import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { filesystemApi } from "../../../api";
import type { TimelineDocument } from "../../../shared/domain";
import { askSavePath, fileSafeName } from "../../editor/launcher/savePath";
import { useAppStore } from "../../editor/stores/appStore";
import {
  ExitFullscreenIcon,
  FullscreenIcon,
  LoopIcon,
  PauseIcon,
  PlayIcon,
  SkipEndIcon,
  SkipStartIcon,
  SnapshotIcon,
  VolumeIcon,
} from "../components/ClipIcons";
import { useClipStore, type PreviewQuality } from "../stores/clipStore";
import { cutEndMs } from "../timeline/geometry";
import { formatTimecode } from "../timeline/timecode";

interface ClipTransportProps {
  timeline: TimelineDocument;
}

/** What the player reads, in the reference's order: skips, clock, sound, then the pane. */
const QUALITY_LABELS: { value: PreviewQuality; label: string }[] = [
  { value: "full", label: "clip:transport.qualityFull" },
  { value: "half", label: "clip:transport.qualityHalf" },
  { value: "quarter", label: "clip:transport.qualityQuarter" },
];

/**
 * The row's clock: the playhead, and the end of the cut beside it.
 *
 * A component of its own so the moment moving re-renders this line and not the
 * row around it — every button, slider and select here belongs to the reader's
 * hands, and a clock that dragged them all through a render each frame would
 * be work nobody asked for.
 */
function TransportTimecode({ endMs, fps }: { endMs: number; fps: number }) {
  const { t } = useTranslation();
  const playheadMs = useClipStore((state) => state.playheadMs);
  return (
    <span
      className="clip-transport-time"
      data-testid="transport-timecode"
      title={t("clip:transport.clockHint")}
    >
      {formatTimecode(playheadMs, fps)} /{" "}
      {formatTimecode(endMs <= 0 ? 0 : endMs, fps)}
    </span>
  );
}

/**
 * The row under the picture: everything that plays the cut.
 *
 * A reading of the store rather than a player of its own — pressing play sets
 * a flag, and the room's clock (07's transport hook) is what moves. The two
 * timecodes are the playhead and the end of the cut, and a cut with nothing
 * on a row that draws is all the row has to disable: skips, repeat, and the
 * camera have nowhere to go, while the frame badge still reads its rate.
 *
 * The snapshot is the preview's own canvas saved as a PNG, named for the
 * timeline and the moment, through the same blob-and-anchor path the board's
 * "export as image" uses. Fullscreen is asked of the preview pane, so the
 * picture and this row go to the whole window together and the button comes
 * back round to leave.
 */
export function ClipTransport({ timeline }: ClipTransportProps) {
  const { t } = useTranslation();
  const playing = useClipStore((state) => state.playing);
  const quality = useClipStore((state) => state.quality);
  const masterVolume = useClipStore((state) => state.masterVolume);
  const loop = useClipStore((state) => state.loop);
  const [fullscreen, setFullscreen] = useState(false);
  const fps = timeline.settings.fps;
  const endMs = cutEndMs(timeline);
  const empty = endMs <= 0;

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  /** The frame under the playhead, saved where the reader asked for it. */
  const saveSnapshot = async (): Promise<void> => {
    const canvas = document.querySelector(".clip-preview-canvas");
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) return;
    // The clock's own colons are not a name a file may wear, so the moment is
    // written the way the rest of the name is.
    const moment = formatTimecode(
      useClipStore.getState().playheadMs,
      fps,
    ).replace(/:/g, "-");
    const destination = await askSavePath({
      title: t("clip:transport.saveSnapshotTitle"),
      defaultName: `${fileSafeName(timeline.name)}-${moment}.png`,
      extensions: ["png"],
    });
    if (destination === null) return;
    try {
      await filesystemApi.write(destination, blob);
      useAppStore
        .getState()
        .pushToast(
          "success",
          t("clip:transport.snapshotSaved", { path: destination }),
        );
    } catch (problem) {
      useAppStore
        .getState()
        .pushToast(
          "error",
          problem instanceof Error ? problem.message : String(problem),
        );
    }
  };

  /** The whole pane to the window, or back: the button says which it will do. */
  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    const preview = document.querySelector(".clip-preview");
    if (preview instanceof HTMLElement)
      void preview.requestFullscreen().catch(() => {
        // A browser that will not go fullscreen leaves the pane as it is.
      });
  };

  return (
    <div className="clip-transport">
      <div className="clip-transport-group">
        <button
          aria-label={t("clip:transport.backToStart")}
          className="clip-transport-button"
          disabled={empty}
          onClick={() => useClipStore.getState().setPlayhead(0)}
          title={t("clip:transport.backToStart")}
          type="button"
        >
          <SkipStartIcon size={16} />
        </button>
        <button
          aria-label={
            playing ? t("clip:transport.pause") : t("clip:transport.play")
          }
          className="clip-transport-button is-play"
          disabled={empty}
          onClick={() => useClipStore.getState().togglePlay()}
          title={playing ? t("clip:transport.pause") : t("clip:transport.play")}
          type="button"
        >
          {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
        </button>
        <button
          aria-label={t("clip:transport.toEnd")}
          className="clip-transport-button"
          disabled={empty}
          onClick={() => useClipStore.getState().setPlayhead(endMs)}
          title={t("clip:transport.toEnd")}
          type="button"
        >
          <SkipEndIcon size={16} />
        </button>
      </div>

      <TransportTimecode endMs={endMs} fps={fps} />

      <div className="clip-transport-group">
        <button
          aria-label={t("clip:transport.repeat")}
          aria-pressed={loop}
          className={
            loop ? "clip-transport-button is-on" : "clip-transport-button"
          }
          disabled={empty}
          onClick={() => useClipStore.getState().toggleLoop()}
          title={t("clip:transport.repeat")}
          type="button"
        >
          <LoopIcon size={16} />
        </button>
        <span className="clip-transport-volume">
          <VolumeIcon size={15} />
          <input
            aria-label={t("clip:transport.masterVolume")}
            className="clip-transport-slider"
            max={1}
            min={0}
            onChange={(event) =>
              useClipStore
                .getState()
                .setMasterVolume(Number(event.target.value))
            }
            step={0.01}
            title={t("clip:transport.masterVolume")}
            type="range"
            value={masterVolume}
          />
        </span>
      </div>

      <span className="clip-transport-fps" title={t("clip:transport.fpsHint")}>
        {fps}fps
      </span>

      <select
        aria-label={t("clip:transport.quality")}
        className="clip-transport-quality"
        onChange={(event) =>
          useClipStore
            .getState()
            .setQuality(event.target.value as PreviewQuality)
        }
        title={t("clip:transport.quality")}
        value={quality}
      >
        {QUALITY_LABELS.map((tier) => (
          <option key={tier.value} value={tier.value}>
            {t(tier.label)}
          </option>
        ))}
      </select>

      <div className="clip-transport-group clip-transport-end">
        <button
          aria-label={t("clip:transport.snapshot")}
          className="clip-transport-button"
          disabled={empty}
          onClick={() => void saveSnapshot()}
          title={t("clip:transport.snapshot")}
          type="button"
        >
          <SnapshotIcon size={16} />
        </button>
        <button
          aria-label={
            fullscreen
              ? t("clip:transport.exitFullscreen")
              : t("clip:transport.fullscreen")
          }
          className="clip-transport-button"
          onClick={toggleFullscreen}
          title={
            fullscreen
              ? t("clip:transport.exitFullscreen")
              : t("clip:transport.fullscreen")
          }
          type="button"
        >
          {fullscreen ? (
            <ExitFullscreenIcon size={16} />
          ) : (
            <FullscreenIcon size={16} />
          )}
        </button>
      </div>
    </div>
  );
}
