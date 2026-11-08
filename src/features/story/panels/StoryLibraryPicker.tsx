import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { assetThumbUrl } from "../../../api/assets";
import { useProjectStore } from "../../editor/stores/projectStore";

/** How wide a library tile is asked for: the tile is a few hundred pixels
    wide and the file it draws from may be megabytes. */
const LIBRARY_THUMB_WIDTH = 320;

/**
 * The pictures a project already holds, as the place an element's drawing may
 * be taken from.
 *
 * Nothing is generated here and nothing is filed: a reader who has the picture
 * already — one drawn in another telling, or brought in from their own files —
 * binds it to the element the way a generated one would be bound, and the file
 * stays on the shelf for the next place that wants it.
 */
export function StoryLibraryPicker({
  label,
  current,
  onChoose,
  onClose,
}: {
  label: string;
  /** The file the place is keeping just now, marked in the grid. */
  current: string | undefined;
  onChoose: (assetId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const images = useProjectStore((state) => state.moka?.resources.images ?? []);

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
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        aria-label={t("story:panels.library", { label })}
        aria-modal="true"
        className="story-picks"
        data-testid="story-library"
        role="dialog"
      >
        <h2>{t("story:panels.library", { label })}</h2>
        {images.length === 0 ? (
          <p className="story-hint" data-testid="story-library-empty">
            {t("story:panels.libraryEmpty")}
          </p>
        ) : (
          <div className="story-picks-grid">
            {images.map((entry) => (
              <button
                className={`story-pick${entry.id === current ? " is-current" : ""}`}
                data-testid={`story-library-${entry.id}`}
                key={entry.id}
                onClick={() => onChoose(entry.id)}
                type="button"
              >
                <img
                  alt={entry.name}
                  decoding="async"
                  loading="lazy"
                  src={assetThumbUrl(entry.id, LIBRARY_THUMB_WIDTH)}
                />
                <span className="story-pick-foot">{entry.name}</span>
              </button>
            ))}
          </div>
        )}
        <div className="dialog-actions">
          <button onClick={onClose} type="button">
            {t("story:panels.close")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
