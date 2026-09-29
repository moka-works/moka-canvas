import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { assetThumbUrl } from "../../../api/assets";
import { relativeTime } from "../relativeTime";
import type { StoryTake } from "../../../shared/domain/types";

/** How wide a take's tile is asked for: the tile is a few hundred
    pixels wide and the file it draws from may be megabytes. */
const PICK_THUMB_WIDTH = 320;

/**
 * The drawings a place has been given, and which of them is being kept.
 *
 * A redraw does not throw the old one away — it appends — so what a reader is
 * shown here is the place's history, newest at the bottom, with the current
 * take marked. Choosing one moves it to the head of the list, which is what
 * every other part of the room reads as "the picture of this place".
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
  onChoose,
  onRemove,
  onClose,
}: {
  takes: StoryTake[];
  /** The asset the place is keeping just now. */
  current: string | undefined;
  label: string;
  onChoose: (assetId: string) => void;
  /** Throws an old drawing away, and answers the line to say under the list. */
  onRemove: (assetId: string) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
        aria-label={t("story:panels.picks", { label })}
        aria-modal="true"
        className="story-picks"
        data-testid="story-picks"
        role="dialog"
      >
        <h2>{t("story:panels.picks", { label })}</h2>
        <div className="story-picks-grid">
          {takes.map((take) => {
            // A place with a history of takes is drawn: every take here is one
            // file, whatever the act clips beside it may be.
            const file = take.assetIds[0];
            const keeping = file === current;
            return (
              <div className="story-pick-tile" key={file}>
                <button
                  className={`story-pick${keeping ? " is-current" : ""}${asking === file ? " is-asking" : ""}`}
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
                {!keeping && (
                  <button
                    aria-label={t("story:panels.removeOld", { label })}
                    className="story-pick-remove"
                    data-testid={`story-pick-remove-${file}`}
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
            aria-label={t("story:panels.removeAsk")}
            className="story-pick-ask"
            data-testid="story-pick-ask"
            role="alertdialog"
          >
            <p>{t("story:panels.removeAsk")}</p>
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
