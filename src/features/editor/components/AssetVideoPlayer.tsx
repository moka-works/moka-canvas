import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDuration } from "../canvas/mediaCards";

interface AssetVideoPlayerProps {
  src: string;
  /** The still the player leads with before the file has been played. */
  poster?: string;
  /** Whether the player asks the file to run as soon as it can. */
  autoPlay?: boolean;
  /** What the file itself is called in its surroundings, when it needs a name. */
  videoClassName?: string;
}

/** The play mark: a solid triangle, the way the canvas draws it. */
function PlayMark() {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      height="14"
      viewBox="0 0 24 24"
      width="14"
    >
      <path d="M8.4 5.4v13.2l10.8-6.6z" />
    </svg>
  );
}

/** Two bars: hold the film where it stands. */
function PauseMark() {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      height="14"
      viewBox="0 0 24 24"
      width="14"
    >
      <path d="M7.6 5.2h3.2v13.6H7.6zM13.2 5.2h3.2v13.6h-3.2z" />
    </svg>
  );
}

/** A speaker: sound on, or crossed out when the film is held quiet. */
function SoundMark({ muted }: { muted: boolean }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="15"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width="15"
    >
      <path d="M4.5 9.5h3l4-3.2v11.4l-4-3.2h-3z" />
      {muted ? (
        <path d="m14.6 9.6 4.6 4.8m0-4.8-4.6 4.8" />
      ) : (
        <>
          <path d="M14.6 9.8a3.4 3.4 0 0 1 0 4.4" />
          <path d="M17.1 7.4a6.6 6.6 0 0 1 0 9.2" />
        </>
      )}
    </svg>
  );
}

/** Four corners: the player to the whole screen, and back. */
function ScreenMark({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="14"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width="14"
    >
      {open ? (
        <>
          <path d="M9.5 5.5v4h-4M14.5 5.5v4h4M9.5 18.5v-4h-4M14.5 18.5v-4h4" />
        </>
      ) : (
        <>
          <path d="M5.5 9.5v-4h4M18.5 9.5v-4h-4M5.5 14.5v4h4M18.5 14.5v4h-4" />
        </>
      )}
    </svg>
  );
}

/**
 * A film, with the timeline a reader needs to find one moment in it.
 *
 * The column's own player rather than the browser's: the controls under the
 * picture are the same on every platform, the timeline is wide enough to aim
 * with, and dragging it seeks the file — paused, a drag steps through stills
 * as it goes, and the play control starts from wherever the timeline stands.
 *
 * Nothing runs until it is asked to. A file opens on its own first frame, so
 * a stage or a column reads a picture rather than a film already playing.
 */
export function AssetVideoPlayer({
  src,
  poster,
  autoPlay = false,
  videoClassName,
}: AssetVideoPlayerProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // What the browser said when it would not play the file. A play that answers
  // with nothing at all is the one failure worth naming.
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const onChange = () =>
      setFullscreen(document.fullscreenElement === playerRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (!video.paused) {
      video.pause();
      return;
    }
    video.play().catch((problem: unknown) => {
      setFailure(problem instanceof Error ? problem.message : String(problem));
    });
  };

  const seek = (ms: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = ms / 1000;
    setPositionMs(ms);
  };

  const toggleSound = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  };

  const toggleFullscreen = () => {
    const player = playerRef.current;
    if (!player) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    if (typeof player.requestFullscreen !== "function") return;
    void player.requestFullscreen().catch(() => {
      // A browser that will not go fullscreen leaves the player as it is.
    });
  };

  const noteDuration = () => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    setDurationMs(video.duration * 1000);
  };

  return (
    <div className="asset-player" ref={playerRef}>
      <video
        autoPlay={autoPlay}
        className={videoClassName}
        data-testid="asset-preview-video"
        onClick={togglePlay}
        onDurationChange={noteDuration}
        onEnded={() => setPlaying(false)}
        onError={() => {
          const problem = videoRef.current?.error;
          const reason =
            problem?.message || (problem ? `code ${problem.code}` : "");
          setFailure(
            reason
              ? `${t("editor:player.failed")} — ${reason}`
              : t("editor:player.failed"),
          );
        }}
        onLoadedMetadata={noteDuration}
        onPause={() => setPlaying(false)}
        onPlay={() => {
          setPlaying(true);
          setFailure(null);
        }}
        onTimeUpdate={() => {
          const video = videoRef.current;
          if (video) setPositionMs(video.currentTime * 1000);
        }}
        playsInline
        poster={poster}
        preload="metadata"
        ref={videoRef}
        src={src}
      />
      <div className="asset-player-transport">
        <button
          aria-label={t(playing ? "editor:player.pause" : "editor:player.play")}
          className="asset-player-button"
          data-testid="asset-player-toggle"
          onClick={togglePlay}
          title={t(playing ? "editor:player.pause" : "editor:player.play")}
          type="button"
        >
          {playing ? <PauseMark /> : <PlayMark />}
        </button>
        <span className="asset-player-clock" data-testid="asset-player-clock">
          {formatDuration(positionMs)} / {formatDuration(durationMs)}
        </span>
        <input
          aria-label={t("editor:player.seek")}
          aria-valuetext={`${formatDuration(positionMs)} / ${formatDuration(durationMs)}`}
          className="asset-player-seek"
          data-testid="asset-player-seek"
          disabled={durationMs <= 0}
          max={Math.max(0, Math.round(durationMs))}
          min={0}
          onChange={(event) => seek(Number(event.target.value))}
          step={100}
          type="range"
          value={Math.min(positionMs, durationMs)}
        />
        <button
          aria-label={t(muted ? "editor:player.unmute" : "editor:player.mute")}
          aria-pressed={muted}
          className="asset-player-button"
          onClick={toggleSound}
          title={t(muted ? "editor:player.unmute" : "editor:player.mute")}
          type="button"
        >
          <SoundMark muted={muted} />
        </button>
        <button
          aria-label={t(
            fullscreen
              ? "editor:player.exitFullscreen"
              : "editor:player.fullscreen",
          )}
          className="asset-player-button"
          onClick={toggleFullscreen}
          title={t(
            fullscreen
              ? "editor:player.exitFullscreen"
              : "editor:player.fullscreen",
          )}
          type="button"
        >
          <ScreenMark open={fullscreen} />
        </button>
      </div>
      {failure && (
        <p className="asset-player-failure" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
