import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { assetThumbUrl, assetUrl } from "../../../api/assets";
import { relativeTime } from "../relativeTime";
import type { StoryTake } from "../../../shared/domain/types";

/** How wide a take's tile is asked for: the tile is a few hundred
    pixels wide and the file it draws from may be megabytes. */
const PICK_THUMB_WIDTH = 320;

/**
 * The takes a place has been given, and which of them is being kept.
 *
 * A redraw does not throw the old one away — it appends — so what a reader is
 * shown here is the place's history, newest at the bottom, with the current
 * take marked. Choosing one moves it to the end of the list, which is what
 * every other part of the room reads as "the take of this place". A picture is
 * looked at; a clip is watched, and chosen by the press beside its player.
 *
 * An old drawing is also thrown away from here, and that is not the same act as
 * choosing: the take leaves the place and its file leaves the shelf. Only the
 * drawings the place is not using can go, since letting the one in use go would
 * leave the place holding a picture nobody chose. The ask is made in this
 * dialog and answered in it: what stands over the step is this list, and
 * anything thrown over it would only be a second veil to read through.
 */
export function StoryPicks({
  takes,
  current,
  label,
  kind = "picture",
  poster,
  onChoose,
  onRemove,
  onClose,
}: {
  takes: StoryTake[];
  /** The asset the place is keeping just now. */
  current: string | undefined;
  label: string;
  /**
   * What a take is here: a drawing, looked at; a clip, watched; or a piece of
   * sound, listened to. A clip's or a recording's takes are judged by playing
   * them, and the player answers clicks of its own, so choosing one is a press
   * beside it.
   */
  kind?: "picture" | "clip" | "audio";
  /** The still a clip's player stands on before it is played. */
  poster?: string;
  onChoose: (assetId: string) => void;
  /** Throws an old take away, and answers the line to say under the list. */
  onRemove: (assetId: string) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // A drawing is a picture of a place; a clip or a recording is a take heard
  // before it is kept, and is asked about in the words a take is asked in.
  const isTake = kind !== "picture";
  const prefix = kind === "audio" ? "story-audio" : "story-clip";
  const removeAsk =
    kind === "audio"
      ? t("story:panels.removeAskVoice")
      : kind === "clip"
        ? t("story:panels.removeAskClip")
        : t("story:panels.removeAsk");

  /** Leaves the ask first: a question standing is not one to walk out of. */
  const close = () => {
    if (asking !== null) {
      setAsking(null);
      return;
    }
    onClose();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const ask = (file: string) => {
    setNotice(null);
    setAsking(file);
  };

  const confirmRemove = async () => {
    if (asking === null) return;
    setRemoving(true);
    try {
      const line = await onRemove(asking);
      setNotice(line ?? null);
    } finally {
      setRemoving(false);
      setAsking(null);
    }
  };

  return createPortal(
    <div
      className="story-lightbox"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      role="presentation"
    >
      <div
        aria-label={t(
          isTake ? "story:panels.picksClip" : "story:panels.picks",
          { label },
        )}
        aria-modal="true"
        className="story-picks"
        data-testid={isTake ? `${prefix}-picks` : "story-picks"}
        role="dialog"
      >
        <h2>
          {t(isTake ? "story:panels.picksClip" : "story:panels.picks", {
            label,
          })}
        </h2>
        <div
          className={`story-picks-grid${kind === "clip" ? " is-clip" : kind === "audio" ? " is-audio" : ""}`}
        >
          {takes.map((take) => {
            // A take is known by the file it opens on: an act filmed in pieces
            // keeps several, and the first is what the list marks and chooses.
            const file = take.assetIds[0];
            const keeping = file === current;
            const state = `${keeping ? " is-current" : ""}${asking === file ? " is-asking" : ""}`;
            return (
              <div className="story-pick-tile" key={file}>
                {kind === "picture" ? (
                  <button
                    className={`story-pick${state}`}
                    data-testid={`story-pick-${file}`}
                    onClick={() => onChoose(file)}
                    type="button"
                  >
                    <img
                      alt={label}
                      src={assetThumbUrl(file, PICK_THUMB_WIDTH)}
                    />
                    <span className="story-pick-foot">
                      {take.createdAt === undefined
                        ? t("story:panels.pickUndated")
                        : relativeTime(take.createdAt)}
                      {keeping && (
                        <span className="story-pick-current">
                          {t("story:panels.pickCurrent")}
                        </span>
                      )}
                    </span>
                  </button>
                ) : (
                  <div
                    className={`story-pick${kind === "clip" ? " is-clip" : " is-audio"}${state}`}
                    data-testid={`${prefix}-pick-${file}`}
                  >
                    {kind === "clip" ? (
                      <video
                        aria-label={label}
                        controls
                        poster={poster}
                        preload="metadata"
                        src={assetUrl(file)}
                      />
                    ) : (
                      <audio
                        aria-label={label}
                        controls
                        preload="metadata"
                        src={assetUrl(file)}
                      />
                    )}
                    <span className="story-pick-foot">
                      <span>
                        {take.createdAt === undefined
                          ? t("story:panels.pickUndated")
                          : relativeTime(take.createdAt)}
                      </span>
                      <span>
                        {take.assetIds.length > 1
                          ? t("story:panels.pieces", {
                              count: take.assetIds.length,
                            })
                          : ""}
                      </span>
                      {keeping && (
                        <span className="story-pick-current">
                          {t("story:panels.pickCurrent")}
                        </span>
                      )}
                    </span>
                    {!keeping && (
                      <button
                        className="link story-pick-keep"
                        data-testid={`${prefix}-keep-${file}`}
                        onClick={() => onChoose(file)}
                        type="button"
                      >
                        {t("story:panels.keepClip")}
                      </button>
                    )}
                  </div>
                )}
                {!keeping && (
                  <button
                    aria-label={t(
                      kind === "audio"
                        ? "story:panels.removeOldVoice"
                        : kind === "clip"
                          ? "story:panels.removeOldClip"
                          : "story:panels.removeOld",
                      { label },
                    )}
                    className="story-pick-remove"
                    data-testid={
                      kind === "picture"
                        ? `story-pick-remove-${file}`
                        : `${prefix}-pick-remove-${file}`
                    }
                    onClick={() => ask(file)}
                    type="button"
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {notice !== null && (
          <p
            className="story-pick-notice"
            data-testid="story-pick-notice"
            role="status"
          >
            {notice}
          </p>
        )}
        <div className="dialog-actions">
          <button onClick={close} type="button">
            {t("story:panels.close")}
          </button>
        </div>
        {asking !== null && (
          <div
            aria-label={removeAsk}
            className="story-pick-ask"
            data-testid="story-pick-ask"
            role="alertdialog"
          >
            <p>{removeAsk}</p>
            <p className="story-hint">{t("story:panels.removeNote")}</p>
            <div className="dialog-actions">
              <button
                data-testid="story-pick-remove-cancel"
                disabled={removing}
                onClick={() => setAsking(null)}
                type="button"
              >
                {t("story:panels.cancel")}
              </button>
              <button
                className="danger"
                data-testid="story-pick-remove-confirm"
                disabled={removing}
                onClick={() => void confirmRemove()}
                type="button"
              >
                {t("story:panels.removeDo")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
