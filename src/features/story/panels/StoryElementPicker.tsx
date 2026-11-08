import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { assetThumbUrl } from "../../../api/assets";
import {
  currentTake,
  elementForms,
  formName,
  type StoryDocument,
} from "../../../shared/domain";

/** How wide a tile's picture is asked for: a few hundred pixels at most. */
const PICK_THUMB_WIDTH = 320;

/**
 * The drawings the story already holds, as a set of pictures a shot may carry
 * beside its cast.
 *
 * Every form of an element is a picture of its own, so each is offered as its
 * own tile; choosing a drawing keeps a reference to the element and form, and
 * the picture that travels is whichever that form keeps at the time.
 */
export function StoryElementPicker({
  story,
  onChoose,
  onClose,
}: {
  story: StoryDocument;
  onChoose: (
    elementId: string,
    variantId: string | undefined,
    name: string,
  ) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const all = story.elements.flatMap((element) =>
    elementForms(element).map((variant) => ({ element, variant })),
  );
  const search = query.trim().toLowerCase();
  const shown = all.filter(({ element, variant }) => {
    if (search === "") return true;
    return (
      formName(element, variant).toLowerCase().includes(search) ||
      element.name.toLowerCase().includes(search)
    );
  });

  return createPortal(
    <div
      className="story-lightbox"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        aria-label={t("story:storyboard.pickElement")}
        aria-modal="true"
        className="story-picks"
        data-testid="story-element-picker"
        role="dialog"
      >
        <h2>{t("story:storyboard.pickElement")}</h2>
        <p className="story-hint">{t("story:storyboard.pickElementHint")}</p>
        {all.length > 0 && (
          <input
            aria-label={t("story:storyboard.pickElementSearch")}
            className="story-search"
            data-testid="story-element-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("story:storyboard.pickElementSearch")}
            type="search"
            value={query}
          />
        )}
        {all.length === 0 ? (
          <p className="story-hint">{t("story:elements.empty")}</p>
        ) : shown.length === 0 ? (
          <p className="story-hint" data-testid="story-element-no-match">
            {t("story:storyboard.pickElementSearchEmpty", {
              query: query.trim(),
            })}
          </p>
        ) : (
          <div className="story-picks-grid">
            {shown.map(({ element, variant }) => (
              <ElementTile
                elementId={element.id}
                key={`${element.id}:${variant?.id ?? ""}`}
                name={formName(element, variant)}
                onChoose={() =>
                  onChoose(element.id, variant?.id, formName(element, variant))
                }
                picture={
                  currentTake(variant?.main ?? element.main)?.assetIds[0]
                }
              />
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

/** One drawing of one form, as a tile that may be carried with a shot. */
function ElementTile({
  elementId,
  name,
  picture,
  onChoose,
}: {
  elementId: string;
  name: string;
  picture: string | undefined;
  onChoose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      className="story-pick"
      data-testid={`story-element-pick-${elementId}-${name}`}
      onClick={onChoose}
      type="button"
    >
      {picture === undefined ? (
        <span className="story-pick-empty">
          {t("story:elements.referenceUndrawn")}
        </span>
      ) : (
        <img
          alt={name}
          decoding="async"
          loading="lazy"
          src={assetThumbUrl(picture, PICK_THUMB_WIDTH)}
        />
      )}
      <span className="story-pick-foot">{name}</span>
    </button>
  );
}
