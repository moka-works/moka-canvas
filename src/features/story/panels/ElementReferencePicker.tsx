import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { assetThumbUrl } from "../../../api/assets";
import {
  currentTake,
  type StoryDocument,
  type StoryElement,
  type StoryPictureReference,
} from "../../../shared/domain";
import { useProjectStore } from "../../editor/stores/projectStore";
import { filePictureFromComputer } from "./elementPictures";

/** How wide a tile's picture is asked for: a few hundred pixels at most. */
const PICK_THUMB_WIDTH = 320;

/**
 * The picture an element's drawing is made from: another element of the story,
 * or a file on the shelf — including one brought in from this computer, which
 * is filed there first.
 *
 * The element's own card is not offered: a form starts out made from its
 * element's default form, and that is said in the reference row rather than
 * picked here.
 */
export function ElementReferencePicker({
  story,
  element,
  current,
  onChoose,
  onClose,
}: {
  story: StoryDocument;
  element: StoryElement;
  current: StoryPictureReference | undefined;
  onChoose: (reference: StoryPictureReference) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const shelf = useProjectStore((state) => state.moka?.resources.images ?? []);
  const file = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const search = query.trim().toLowerCase();
  const matches = (name: string) =>
    search === "" || name.toLowerCase().includes(search);
  const others = story.elements
    .filter((held) => held.id !== element.id)
    .filter((held) => matches(held.name));
  const images = shelf.filter((entry) => matches(entry.name));
  const chosenElement =
    current?.kind === "element" ? current.elementId : undefined;
  const chosenAsset = current?.kind === "asset" ? current.assetId : undefined;

  return createPortal(
    <div
      className="story-lightbox"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        aria-label={t("story:elements.referencePick")}
        aria-modal="true"
        className="story-picks"
        data-testid="story-reference-picker"
        role="dialog"
      >
        <h2>{t("story:elements.referencePick")}</h2>
        <p className="story-hint">{t("story:elements.referenceLead")}</p>

        <input
          aria-label={t("story:elements.referenceSearch")}
          className="story-search"
          data-testid="story-reference-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("story:elements.referenceSearchPlaceholder")}
          type="search"
          value={query}
        />

        {search !== "" && others.length === 0 && images.length === 0 ? (
          <p className="story-hint" data-testid="story-reference-no-match">
            {t("story:elements.referenceSearchEmpty", { query: query.trim() })}
          </p>
        ) : (
          <>
            {(search === "" || others.length > 0) && (
              <>
                <h3 className="story-picks-heading">
                  {t("story:elements.referenceElements")}
                </h3>
                {others.length === 0 ? (
                  <p className="story-hint">
                    {t("story:elements.referenceNoElements")}
                  </p>
                ) : (
                  <div className="story-picks-grid">
                    {others.map((held) => {
                      const take = currentTake(held.main);
                      return (
                        <button
                          className={`story-pick${chosenElement === held.id ? " is-current" : ""}`}
                          data-testid={`story-reference-element-${held.id}`}
                          key={held.id}
                          onClick={() =>
                            onChoose({ kind: "element", elementId: held.id })
                          }
                          type="button"
                        >
                          {take === undefined ? (
                            <span className="story-pick-empty">
                              {t("story:elements.referenceUndrawn")}
                            </span>
                          ) : (
                            <img
                              alt={held.name}
                              decoding="async"
                              loading="lazy"
                              src={assetThumbUrl(
                                take.assetIds[0] ?? "",
                                PICK_THUMB_WIDTH,
                              )}
                            />
                          )}
                          <span className="story-pick-foot">{held.name}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {(search === "" || images.length > 0) && (
              <>
                <h3 className="story-picks-heading">
                  {t("story:elements.referenceAssets")}
                </h3>
                {images.length === 0 ? (
                  <p
                    className="story-hint"
                    data-testid="story-reference-assets-empty"
                  >
                    {t("story:elements.referenceNoAssets")}
                  </p>
                ) : (
                  <div className="story-picks-grid">
                    {images.map((entry) => (
                      <button
                        className={`story-pick${chosenAsset === entry.id ? " is-current" : ""}`}
                        data-testid={`story-reference-asset-${entry.id}`}
                        key={entry.id}
                        onClick={() =>
                          onChoose({ kind: "asset", assetId: entry.id })
                        }
                        type="button"
                      >
                        <img
                          alt={entry.name}
                          decoding="async"
                          loading="lazy"
                          src={assetThumbUrl(entry.id, PICK_THUMB_WIDTH)}
                        />
                        <span className="story-pick-foot">{entry.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}

        <div className="story-reference-upload">
          <button
            className="link"
            data-testid="story-reference-upload"
            onClick={() => file.current?.click()}
            type="button"
          >
            {t("story:elements.referenceUpload")}
          </button>
          <input
            accept="image/*"
            data-testid="story-reference-upload-input"
            hidden
            onChange={async (event) => {
              const chosen = event.target.files?.[0];
              event.target.value = "";
              if (chosen === undefined) return;
              const assetId = await filePictureFromComputer(chosen);
              if (assetId !== undefined) onChoose({ kind: "asset", assetId });
            }}
            ref={file}
            type="file"
          />
        </div>

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
