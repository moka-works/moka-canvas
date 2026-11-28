import { useState, type MouseEvent as ReactMouseEvent, type Ref } from "react";
import { useTranslation } from "react-i18next";
import type { TimelineDocument, TrackKind } from "../../../shared/domain";
import {
  AudioIcon,
  ClipCanvasIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  MutedIcon,
  TextIcon,
  UnlockIcon,
  VolumeIcon,
} from "../components/ClipIcons";
import { TimelineMenu } from "../components/TimelineMenu";
import { setTrackFlag, setTrackGain } from "../interactions/clipActions";
import { trackRows } from "./geometry";

interface TrackHeadersProps {
  timeline: TimelineDocument;
  /** Held by the canvas, which moves this column with the viewport's vertical scroll. */
  ref?: Ref<HTMLDivElement>;
}

interface HeaderMenu {
  x: number;
  y: number;
  trackId: string;
}

/** The mark a row leads with, one per kind of track. */
function kindGlyph(kind: TrackKind) {
  if (kind === "video") return <ClipCanvasIcon size={15} />;
  if (kind === "audio") return <AudioIcon size={15} />;
  return <TextIcon size={15} />;
}

/**
 * The rows' names and switches, beside the canvas.
 *
 * What a track is called and what state it is in, and the one press each
 * toggle takes to change either: a row's mute is not offered on a text row,
 * since words have no sound to hold back. Every switch is one command and
 * one step of history, so a row muted by mistake is one undo from speaking
 * again. The column follows the viewport's vertical scroll by the canvas's
 * hand, since the scroller is the only place a scroll happens.
 */
export function TrackHeaders({ timeline, ref }: TrackHeadersProps) {
  const { t } = useTranslation();
  const rows = trackRows(timeline);
  const [menu, setMenu] = useState<HeaderMenu | null>(null);

  const openMenu = (
    event: ReactMouseEvent<HTMLDivElement>,
    trackId: string,
  ) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, trackId });
  };

  return (
    <div className="clip-tl-headers" ref={ref}>
      {rows.map((row) => (
        <div
          className={
            row.track.hidden
              ? "clip-tl-header-row is-hidden"
              : "clip-tl-header-row"
          }
          data-track-id={row.track.id}
          key={row.track.id}
          onContextMenu={(event) => openMenu(event, row.track.id)}
          style={{ height: row.height }}
          title={row.track.name}
        >
          <span aria-hidden="true" className="clip-tl-track-kind">
            {kindGlyph(row.track.kind)}
          </span>
          <span className="clip-tl-track-name">{row.track.name}</span>
          <span className="clip-tl-track-flags">
            {row.track.kind !== "text" && (
              <button
                aria-label={t(
                  row.track.muted
                    ? "clip:trackHeaders.unmuteTrack"
                    : "clip:trackHeaders.muteTrack",
                  { name: row.track.name },
                )}
                aria-pressed={row.track.muted}
                className="clip-tl-track-toggle"
                data-testid="track-mute"
                onClick={() =>
                  setTrackFlag(
                    timeline,
                    row.track.id,
                    "muted",
                    !row.track.muted,
                  )
                }
                title={t(
                  row.track.muted
                    ? "clip:trackHeaders.unmuteTrack"
                    : "clip:trackHeaders.muteTrack",
                  { name: row.track.name },
                )}
                type="button"
              >
                {row.track.muted ? (
                  <MutedIcon size={13} />
                ) : (
                  <VolumeIcon size={13} />
                )}
              </button>
            )}
            {row.track.kind !== "text" && (
              <button
                aria-label={t(
                  row.track.solo
                    ? "clip:trackHeaders.unsoloTrack"
                    : "clip:trackHeaders.soloTrack",
                  { name: row.track.name },
                )}
                aria-pressed={row.track.solo === true}
                className="clip-tl-track-toggle"
                data-testid="track-solo"
                onClick={() =>
                  setTrackFlag(
                    timeline,
                    row.track.id,
                    "solo",
                    row.track.solo !== true,
                  )
                }
                title={t(
                  row.track.solo
                    ? "clip:trackHeaders.unsoloTrack"
                    : "clip:trackHeaders.soloTrack",
                  { name: row.track.name },
                )}
                type="button"
              >
                S
              </button>
            )}
            {row.track.kind !== "text" && (
              <input
                aria-label={t("clip:trackHeaders.gain", {
                  name: row.track.name,
                })}
                className="clip-tl-track-gain"
                data-testid="track-gain"
                defaultValue={(row.track.gainDb ?? 0).toFixed(1)}
                key={`${row.track.id}:${row.track.gainDb ?? 0}`}
                max={12}
                min={-60}
                onBlur={(event) => {
                  const db = Number(event.target.value);
                  if (Number.isFinite(db))
                    setTrackGain(timeline, row.track.id, db);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                step={1}
                type="number"
              />
            )}
            <button
              aria-label={t(
                row.track.hidden
                  ? "clip:trackHeaders.showTrack"
                  : "clip:trackHeaders.hideTrack",
                { name: row.track.name },
              )}
              aria-pressed={row.track.hidden}
              className="clip-tl-track-toggle"
              data-testid="track-hide"
              onClick={() =>
                setTrackFlag(
                  timeline,
                  row.track.id,
                  "hidden",
                  !row.track.hidden,
                )
              }
              title={t(
                row.track.hidden
                  ? "clip:trackHeaders.showTrack"
                  : "clip:trackHeaders.hideTrack",
                { name: row.track.name },
              )}
              type="button"
            >
              {row.track.hidden ? (
                <EyeOffIcon size={13} />
              ) : (
                <EyeIcon size={13} />
              )}
            </button>
            <button
              aria-label={t(
                row.track.locked
                  ? "clip:trackHeaders.unlockTrack"
                  : "clip:trackHeaders.lockTrack",
                { name: row.track.name },
              )}
              aria-pressed={row.track.locked}
              className="clip-tl-track-toggle"
              data-testid="track-lock"
              onClick={() =>
                setTrackFlag(
                  timeline,
                  row.track.id,
                  "locked",
                  !row.track.locked,
                )
              }
              title={t(
                row.track.locked
                  ? "clip:trackHeaders.unlockTrack"
                  : "clip:trackHeaders.lockTrack",
                { name: row.track.name },
              )}
              type="button"
            >
              {row.track.locked ? (
                <LockIcon size={13} />
              ) : (
                <UnlockIcon size={13} />
              )}
            </button>
          </span>
        </div>
      ))}
      {menu && (
        <TimelineMenu
          onClose={() => setMenu(null)}
          target={{ kind: "track", trackId: menu.trackId }}
          timeline={timeline}
          x={menu.x}
          y={menu.y}
        />
      )}
    </div>
  );
}
