import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { errorText } from "../../../api/client";
import { assetUrl } from "../../../api/assets";
import { filesystemApi } from "../../../api/filesystem";
import { findResource } from "../../../shared/domain/validate";
import type { ResourceEntry } from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { askSavePath, fileSafeName } from "../../editor/launcher/savePath";
import { useAppStore } from "../../editor/stores/appStore";
import { useProjectStore } from "../../editor/stores/projectStore";

/** The shortest window a clip may be cut to, in milliseconds. */
const MIN_TRIM_MS = 400;

/** How a moment reads on the trimmer: minutes, seconds, tenths. */
function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 100) / 10);
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/** The extension a file is offered under, from its name or its kind. */
function extensionOf(entry: ResourceEntry | undefined, video: boolean): string {
  const named = /\.[A-Za-z0-9]+$/.exec(entry?.name ?? "")?.[0];
  if (named !== undefined) return named.slice(1).toLowerCase();
  switch (entry?.mime) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "video/quicktime":
      return "mov";
    case "video/webm":
      return "webm";
    default:
      return video ? "mp4" : "png";
  }
}

/**
 * One drawing, as large as the window will take it.
 *
 * The pictures in the room are thumbnails of work a reader is deciding about,
 * so looking closely has to be possible without leaving the step. This is the
 * room's own viewer rather than the editor's preview dialog: that one is a
 * panel of the editor's state — folders, nodes, the canvas a file belongs to —
 * and a frame drawn for a story belongs to none of it.
 *
 * A clip that was filmed in pieces is watched as the pieces: the file that is
 * there is played, and the next opens when it ends, which is the order the card
 * and the finished cut read them in. Where the place has been given a window,
 * the two handles under the clip mark what is played and laid down, and the
 * files are never changed by it — only what the room reads of them.
 */
export function StoryLightbox({
  assetIds,
  label,
  note,
  video,
  poster,
  inMs,
  outMs,
  onTrim,
  onClose,
}: {
  /** The files to show, in the order they play. */
  assetIds: string[];
  /** What the drawing is of, which is also its alt text. */
  label: string;
  /** A line about the view, when there is one worth saying. */
  note?: string;
  /** Whether the place holds a clip rather than a picture. */
  video?: boolean;
  /** The picture the clip opens on, shown until a frame of it is played. */
  poster?: string;
  /** Where the clip's kept window opens in the take; absent is its start. */
  inMs?: number;
  /** Where it closes; absent is the take's end. */
  outMs?: number;
  /** Keeps a changed window, answering nothing when both ends are the whole. */
  onTrim?: (inMs: number | undefined, outMs: number | undefined) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const durations =
    video === true
      ? assetIds.map((id) =>
          moka === null ? undefined : findResource(moka, id)?.probe?.durationMs,
        )
      : [];
  const offsets: number[] = [];
  let measured = 0;
  for (const duration of durations) {
    offsets.push(measured);
    measured += duration ?? 0;
  }
  const timed =
    video === true &&
    durations.length > 0 &&
    durations.every((duration) => duration !== undefined && duration > 0);
  const totalMs = timed ? measured : 0;
  const trim =
    timed && onTrim !== undefined && totalMs > MIN_TRIM_MS ? totalMs : 0;

  function pieceAt(ms: number): number {
    let at = 0;
    for (let index = 0; index < durations.length; index += 1) {
      const offset = offsets[index] ?? 0;
      if (ms >= offset + (durations[index] ?? 0)) {
        at = Math.min(index + 1, durations.length - 1);
      }
    }
    return at;
  }

  const startOf = (ms: number | undefined): number =>
    trim === 0 ? 0 : Math.min(Math.max(ms ?? 0, 0), trim);
  const [range, setRange] = useState(() => {
    const start = startOf(inMs);
    return {
      inMs: start,
      outMs: trim === 0 ? 0 : Math.min(Math.max(outMs ?? trim, start), trim),
    };
  });
  const [at, setAt] = useState(() => (timed ? pieceAt(range.inMs) : 0));
  // Whether the reader has begun watching: a clip opens on its poster and
  // waits to be played, and only the pieces that follow one already being
  // watched start by themselves.
  const [started, setStarted] = useState(false);
  const [momentMs, setMomentMs] = useState(range.inMs);
  const [seeking, setSeeking] = useState<{
    index: number;
    localMs: number;
    resume: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const dragging = useRef<"in" | "out" | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const file = assetIds[Math.min(at, assetIds.length - 1)] ?? "";
  const pieces = assetIds.length;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // A piece opened after the one before it ends may hold the window's other
  // end: the file is asked for the moment the window names, not for its start.
  useEffect(() => {
    if (seeking === null) return;
    const element = videoRef.current;
    if (element === null) return;
    const apply = () => {
      element.currentTime = seeking.localMs / 1000;
      if (seeking.resume) void element.play();
      setSeeking(null);
    };
    if (element.readyState >= 1) apply();
    else element.addEventListener("loadedmetadata", apply, { once: true });
    return () => element.removeEventListener("loadedmetadata", apply);
  }, [seeking]);

  /** Moves the preview to a moment of the take, opening another piece if need be. */
  const seekTo = (ms: number, resume = false): void => {
    if (trim === 0) return;
    const clamped = Math.min(Math.max(ms, range.inMs), range.outMs);
    const index = pieceAt(clamped);
    const localMs = Math.max(0, clamped - (offsets[index] ?? 0));
    setMomentMs(clamped);
    const element = videoRef.current;
    if (index === at && element !== null) {
      element.currentTime = localMs / 1000;
      if (resume) void element.play();
      return;
    }
    setSeeking({ index, localMs, resume });
    setAt(index);
  };

  const msAt = (clientX: number): number => {
    const box = track.current?.getBoundingClientRect();
    if (box === undefined || box.width === 0) return range.inMs;
    const ratio = Math.min(Math.max((clientX - box.left) / box.width, 0), 1);
    return Math.round((ratio * totalMs) / 10) * 10;
  };

  const beginDrag =
    (edge: "in" | "out") =>
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      dragging.current = edge;
      event.currentTarget.setPointerCapture(event.pointerId);
      videoRef.current?.pause();
    };

  const moveHandle = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const edge = dragging.current;
    if (edge === null) return;
    const ms = msAt(event.clientX);
    const next =
      edge === "in"
        ? {
            inMs: Math.max(0, Math.min(ms, range.outMs - MIN_TRIM_MS)),
            outMs: range.outMs,
          }
        : {
            inMs: range.inMs,
            outMs: Math.min(totalMs, Math.max(ms, range.inMs + MIN_TRIM_MS)),
          };
    setRange(next);
    seekTo(edge === "in" ? next.inMs : next.outMs);
  };

  const endDrag = (): void => {
    if (dragging.current === null) return;
    dragging.current = null;
    const kept = rangeRef.current;
    onTrim?.(
      kept.inMs > 0 ? kept.inMs : undefined,
      kept.outMs < totalMs ? kept.outMs : undefined,
    );
  };

  /** The file before the reader, saved where they say it should go. */
  const save = async (): Promise<void> => {
    const entry = moka === null ? undefined : findResource(moka, file);
    const extension = extensionOf(entry, video === true);
    const named = fileSafeName(
      (entry?.name ?? label).replace(/\.[^./\\]+$/, ""),
    );
    const destination = await askSavePath({
      title: t("story:panels.saveTitle"),
      defaultName: `${named === "" ? "story" : named}.${extension}`,
      extensions: [extension],
    });
    if (destination === null) return;
    setSaving(true);
    try {
      const response = await fetch(assetUrl(file));
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      await filesystemApi.write(destination, await response.blob());
      useAppStore
        .getState()
        .pushToast(
          "success",
          i18n.t("story:panels.saved", { path: destination }),
        );
    } catch (problem) {
      const trouble = errorText(problem);
      useAppStore
        .getState()
        .pushToast(
          "error",
          i18n.t("story:panels.saveFailed"),
          undefined,
          trouble.detail ?? trouble.message,
        );
    } finally {
      setSaving(false);
    }
  };

  const percent = (ms: number): number =>
    totalMs === 0 ? 0 : (ms / totalMs) * 100;
  const rangeStart =
    trim === 0 ? 0 : Math.max(0, range.inMs - (offsets[at] ?? 0));
  const rangeEnd =
    trim === 0
      ? (durations[at] ?? 0)
      : Math.min(durations[at] ?? 0, range.outMs - (offsets[at] ?? 0));

  return createPortal(
    <div
      className="story-lightbox"
      data-testid="story-lightbox"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        aria-label={label}
        aria-modal="true"
        className="story-lightbox-body"
        role="dialog"
      >
        {video === true ? (
          <>
            <video
              autoPlay={started && at > 0}
              controls
              key={file}
              onEnded={() => {
                const end = (offsets[at] ?? 0) + (durations[at] ?? 0);
                if (trim !== 0 && end >= range.outMs) {
                  setMomentMs(range.outMs);
                  return;
                }
                setAt((held) => Math.min(held + 1, pieces - 1));
              }}
              onLoadedMetadata={(event) => {
                const element = event.currentTarget;
                const start = Math.max(0, rangeStart);
                if (start > 0 && element.currentTime < start / 1000 - 0.05) {
                  element.currentTime = start / 1000;
                }
              }}
              onPlay={(event) => {
                setStarted(true);
                if (trim !== 0 && momentMs >= range.outMs - 50) {
                  event.currentTarget.pause();
                  seekTo(range.inMs, true);
                }
              }}
              onTimeUpdate={(event) => {
                if (trim === 0) return;
                const element = event.currentTarget;
                const moment = (offsets[at] ?? 0) + element.currentTime * 1000;
                setMomentMs(moment);
                if (moment < range.inMs - 20) {
                  element.currentTime = Math.max(
                    0,
                    (range.inMs - (offsets[at] ?? 0)) / 1000,
                  );
                } else if (moment >= range.outMs - 5) {
                  element.pause();
                  if (rangeEnd > 0) {
                    element.currentTime = Math.min(
                      rangeEnd / 1000,
                      element.duration || rangeEnd / 1000,
                    );
                  }
                  setMomentMs(range.outMs);
                }
              }}
              poster={at === 0 ? poster : undefined}
              preload="metadata"
              ref={videoRef}
              src={assetUrl(file)}
            />
            {trim !== 0 && (
              <div className="story-trim" data-testid="story-trim">
                <span className="story-trim-time">
                  {formatMs(momentMs)} / {formatMs(totalMs)}
                </span>
                <div
                  className="story-trim-track"
                  data-testid="story-trim-track"
                  onClick={(event) => {
                    if (event.target === event.currentTarget) {
                      seekTo(msAt(event.clientX));
                    }
                  }}
                  ref={track}
                  role="presentation"
                >
                  <span
                    className="story-trim-window"
                    style={{
                      left: `${percent(range.inMs)}%`,
                      width: `${percent(range.outMs - range.inMs)}%`,
                    }}
                  />
                  <span
                    className="story-trim-playhead"
                    style={{ left: `${percent(momentMs)}%` }}
                  />
                  <button
                    aria-label={t("story:panels.trimIn")}
                    className="story-trim-handle"
                    data-testid="story-trim-in"
                    onPointerCancel={endDrag}
                    onPointerDown={beginDrag("in")}
                    onPointerMove={moveHandle}
                    onPointerUp={endDrag}
                    style={{ left: `${percent(range.inMs)}%` }}
                    type="button"
                  />
                  <button
                    aria-label={t("story:panels.trimOut")}
                    className="story-trim-handle"
                    data-testid="story-trim-out"
                    onPointerCancel={endDrag}
                    onPointerDown={beginDrag("out")}
                    onPointerMove={moveHandle}
                    onPointerUp={endDrag}
                    style={{ left: `${percent(range.outMs)}%` }}
                    type="button"
                  />
                </div>
                <span className="story-hint">{t("story:panels.trimHint")}</span>
              </div>
            )}
          </>
        ) : (
          <img alt={label} src={assetUrl(file)} />
        )}
        <div className="story-lightbox-foot">
          <span>{label}</span>
          {pieces > 1 && (
            <span className="story-hint" data-testid="story-lightbox-piece">
              {t("story:panels.piece", {
                index: Math.min(at + 1, pieces),
                total: pieces,
              })}
            </span>
          )}
          {note !== undefined && <span className="story-hint">{note}</span>}
          <button
            className="link"
            data-testid="story-lightbox-save"
            disabled={saving}
            onClick={() => void save()}
            type="button"
          >
            {saving ? t("story:panels.saving") : t("story:panels.save")}
          </button>
          <button
            className="link"
            data-testid="story-lightbox-close"
            onClick={onClose}
            type="button"
          >
            {t("story:panels.close")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
