import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { activeShotOf, type DirectorScene } from "../../../shared/domain";
import type { DirectorKeyframeRef, DirectorSelection } from "../types";

export interface BlockingLaneProps {
  scene: DirectorScene;
  playhead: number;
  playing: boolean;
  autoKey: boolean;
  collapsed: boolean;
  onCollapse: () => void;
  onPlayToggle: () => void;
  onPlayhead: (time: number) => void;
  onAutoKey: (on: boolean) => void;
  onShotSelect: (shotId: string) => void;
  onAddShot: () => void;
  onRecord: () => void;
  onSelect: (selection: DirectorSelection | null) => void;
  onEasing: (
    ref: DirectorKeyframeRef,
    easing: "step" | "linear" | "smooth",
  ) => void;
  onDelete: (ref: DirectorKeyframeRef) => void;
}

interface TrackRow {
  key: string;
  label: string;
  color: string;
  frames: {
    id: string;
    time: number;
    selection: DirectorSelection;
    ref: DirectorKeyframeRef;
  }[];
}

const MIN_HEIGHT = 150;
const MAX_HEIGHT = 360;

/**
 * The blocking lane: the clock the shot is worked against.
 *
 * Every row is a thing that can be keyed — the shot, the camera, an object,
 * and the bones inside a performer. A keyframe is a real button: it can be
 * tabbed to, pressed to move the playhead, and deleted; the easing selector
 * acts on the one chosen.
 */
export function BlockingLane({
  scene,
  playhead,
  playing,
  autoKey,
  collapsed,
  onCollapse,
  onPlayToggle,
  onPlayhead,
  onAutoKey,
  onShotSelect,
  onAddShot,
  onRecord,
  onSelect,
  onEasing,
  onDelete,
}: BlockingLaneProps) {
  const { t } = useTranslation("director");
  const shot = activeShotOf(scene);
  const duration = Math.max(0.5, shot?.duration ?? 6);
  const [height, setHeight] = useState(220);
  const [zoom, setZoom] = useState(1.5);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<DirectorKeyframeRef | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selected) return;
    const exists =
      selected.kind === "camera"
        ? scene.cameras
            .find((camera) => camera.id === selected.id)
            ?.keyframes.some((frame) => frame.id === selected.keyframeId)
        : scene.objects
            .find((object) => object.id === selected.id)
            ?.keyframes.some((frame) => frame.id === selected.keyframeId) ||
          scene.objects
            .find((object) => object.id === selected.id)
            ?.boneTracks?.some(
              (track) =>
                track.bone === selected.bone &&
                track.keyframes.some(
                  (frame) => frame.id === selected.keyframeId,
                ),
            );
    if (!exists) setSelected(null);
  }, [scene, selected]);

  if (collapsed) {
    return (
      <button
        className="director-blocking-collapsed"
        onClick={onCollapse}
        type="button"
      >
        {t("blocking.show")}
      </button>
    );
  }

  const rows: TrackRow[] = [];
  if (shot) {
    rows.push({
      key: "cut",
      label: t("blocking.shotRow"),
      color: "#9aa4b2",
      frames: [],
    });
    const camera = scene.cameras.find((entry) => entry.id === shot.cameraId);
    if (camera) {
      rows.push({
        key: `camera:${camera.id}`,
        label: camera.name,
        color: "#61afef",
        frames: camera.keyframes.map((frame) => ({
          id: frame.id,
          time: frame.time,
          selection: { kind: "camera", id: camera.id },
          ref: {
            kind: "camera",
            id: camera.id,
            keyframeId: frame.id,
          },
        })),
      });
    }
  }
  for (const object of scene.objects) {
    const frames: TrackRow["frames"] = object.keyframes.map((frame) => ({
      id: `transform:${frame.id}`,
      time: frame.time,
      selection: { kind: "object" as const, id: object.id },
      ref: {
        kind: "object" as const,
        id: object.id,
        keyframeId: frame.id,
      },
    }));
    for (const track of object.boneTracks ?? []) {
      for (const frame of track.keyframes) {
        frames.push({
          id: `bone:${track.bone}:${frame.id}`,
          time: frame.time,
          selection: { kind: "object", id: object.id, bone: track.bone },
          ref: {
            kind: "object",
            id: object.id,
            bone: track.bone,
            keyframeId: frame.id,
          },
        });
      }
    }
    if (frames.length === 0 && !(object.boneTracks ?? []).length) continue;
    rows.push({
      key: `object:${object.id}`,
      label: object.name,
      color: object.color,
      frames,
    });
    if (expanded.has(object.id)) {
      rows.push({
        key: `object:${object.id}:transform`,
        label: `  ${t("blocking.transformRow")}`,
        color: object.color,
        frames: object.keyframes.map((frame) => ({
          id: `t:${frame.id}`,
          time: frame.time,
          selection: { kind: "object", id: object.id },
          ref: { kind: "object", id: object.id, keyframeId: frame.id },
        })),
      });
      for (const track of object.boneTracks ?? []) {
        rows.push({
          key: `bone:${object.id}:${track.bone}`,
          label: `  ${track.bone}`,
          color: "#b5a1e0",
          frames: track.keyframes.map((frame) => ({
            id: `b:${frame.id}`,
            time: frame.time,
            selection: { kind: "object", id: object.id, bone: track.bone },
            ref: {
              kind: "object",
              id: object.id,
              bone: track.bone,
              keyframeId: frame.id,
            },
          })),
        });
      }
    }
  }

  const beginResize = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const move = (pointer: PointerEvent) => {
      setHeight(
        Math.max(
          MIN_HEIGHT,
          Math.min(MAX_HEIGHT, startHeight + (startY - pointer.clientY)),
        ),
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const timeAt = (clientX: number, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const ratio = (clientX - rect.left) / Math.max(1, rect.width);
    return Math.max(0, Math.min(duration, ratio * duration));
  };

  const width = Math.max(320, duration * 110 * zoom);
  const selectedEasing = (() => {
    if (!selected) return "linear";
    if (selected.kind === "camera") {
      return (
        scene.cameras
          .find((camera) => camera.id === selected.id)
          ?.keyframes.find((frame) => frame.id === selected.keyframeId)
          ?.easing ?? "linear"
      );
    }
    const object = scene.objects.find((entry) => entry.id === selected.id);
    if (!selected.bone) {
      return (
        object?.keyframes.find((frame) => frame.id === selected.keyframeId)
          ?.easing ?? "linear"
      );
    }
    return (
      object?.boneTracks
        ?.find((track) => track.bone === selected.bone)
        ?.keyframes.find((frame) => frame.id === selected.keyframeId)?.easing ??
      "linear"
    );
  })();

  return (
    <section
      aria-label={t("blocking.title")}
      className="director-blocking"
      style={{ height }}
    >
      <div
        aria-label={t("blocking.resize")}
        className="director-blocking-resize"
        onPointerDown={beginResize}
        role="separator"
      />
      <header className="director-blocking-bar">
        <button
          aria-label={playing ? t("blocking.pause") : t("blocking.play")}
          className="director-icon-button"
          onClick={onPlayToggle}
          title={playing ? t("blocking.pause") : t("blocking.play")}
          type="button"
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="director-time">
          {playhead.toFixed(2)}s / {duration.toFixed(2)}s · {shot?.fps ?? 30}fps
        </span>
        <select
          aria-label={t("blocking.shot")}
          onChange={(event) => {
            onShotSelect(event.target.value);
            setSelected(null);
            onPlayhead(0);
          }}
          value={scene.activeShotId}
        >
          {scene.shots.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        <label className="director-blocking-toggle">
          <input
            checked={autoKey}
            onChange={(event) => onAutoKey(event.target.checked)}
            type="checkbox"
          />
          {t("blocking.autoKey")}
        </label>
        <button className="button" onClick={onRecord} type="button">
          {t("blocking.record")}
        </button>
        <label className="director-blocking-toggle">
          <span>{t("blocking.easing")}</span>
          <select
            disabled={!selected}
            onChange={(event) =>
              selected &&
              onEasing(
                selected,
                event.target.value as "step" | "linear" | "smooth",
              )
            }
            value={selectedEasing}
          >
            <option value="step">step</option>
            <option value="linear">linear</option>
            <option value="smooth">smooth</option>
          </select>
        </label>
        <button
          className="button"
          disabled={!selected}
          onClick={() => {
            if (!selected) return;
            onDelete(selected);
            setSelected(null);
          }}
          type="button"
        >
          {t("blocking.delete")}
        </button>
        <label className="director-blocking-toggle">
          <span>{t("blocking.zoom")}</span>
          <select
            onChange={(event) => setZoom(Number(event.target.value))}
            value={String(zoom)}
          >
            {[0.75, 1, 1.5, 2, 2.5].map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </label>
        <button className="button" onClick={onAddShot} type="button">
          + {t("blocking.addShot")}
        </button>
        <button className="button" onClick={onCollapse} type="button">
          {t("blocking.hide")}
        </button>
      </header>
      <div className="director-blocking-body" ref={scrollRef}>
        <div className="director-blocking-content" style={{ width }}>
          <div
            aria-hidden="true"
            className="director-ruler"
            onPointerDown={(event) =>
              onPlayhead(timeAt(event.clientX, event.currentTarget))
            }
          >
            {Array.from(
              { length: Math.max(1, Math.floor(duration)) + 1 },
              (_, second) => (
                <span
                  key={second}
                  style={{ left: `${(second / duration) * 100}%` }}
                >
                  {second}s
                </span>
              ),
            )}
          </div>
          {rows.map((row) => {
            const objectId = row.key.startsWith("object:")
              ? row.key.split(":")[1]
              : null;
            return (
              <div className="director-track" key={row.key}>
                <button
                  className="director-track-name"
                  onClick={() => {
                    if (!objectId) return;
                    setExpanded((held) => {
                      const next = new Set(held);
                      if (next.has(objectId)) next.delete(objectId);
                      else next.add(objectId);
                      return next;
                    });
                  }}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className="director-track-dot"
                    style={{ background: row.color }}
                  />
                  {row.label}
                </button>
                <div className="director-track-lane">
                  {row.key === "cut" && shot && (
                    <span className="director-shot-block">{shot.name}</span>
                  )}
                  {row.frames.map((frame) => (
                    <button
                      aria-label={t("blocking.keyframeAt", {
                        time: frame.time.toFixed(2),
                      })}
                      className={
                        selected?.keyframeId === frame.ref.keyframeId &&
                        selected.id === frame.ref.id
                          ? "director-keyframe is-selected"
                          : "director-keyframe"
                      }
                      key={frame.id}
                      onClick={() => {
                        setSelected(frame.ref);
                        onSelect(frame.selection);
                        onPlayhead(frame.time);
                      }}
                      style={{ left: `${(frame.time / duration) * 100}%` }}
                      title={t("blocking.keyframeAt", {
                        time: frame.time.toFixed(2),
                      })}
                      type="button"
                    />
                  ))}
                </div>
              </div>
            );
          })}
          <div
            aria-hidden="true"
            className="director-playhead"
            style={{ left: `${(playhead / duration) * 100}%` }}
          />
        </div>
      </div>
    </section>
  );
}
