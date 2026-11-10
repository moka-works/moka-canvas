import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { assetUrl } from "../../../api/assets";

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
 * and the finished cut read them in.
 */
export function StoryLightbox({
  assetIds,
  label,
  note,
  video,
  poster,
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
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [at, setAt] = useState(0);
  const file = assetIds[Math.min(at, assetIds.length - 1)] ?? "";
  const pieces = assetIds.length;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
          <video
            autoPlay={at > 0}
            controls
            key={file}
            onEnded={() => setAt((held) => held + 1)}
            poster={at === 0 ? poster : undefined}
            preload="metadata"
            src={assetUrl(file)}
          />
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
