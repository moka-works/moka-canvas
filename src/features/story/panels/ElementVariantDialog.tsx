import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { STORY_NAME_MAX, createElementVariant } from "../../../shared/domain";
import type {
  StoryElement,
  StoryElementVariant,
} from "../../../shared/domain/types";

/**
 * The forms one element takes, as a list the reader arranges.
 *
 * A form is a whole element in all but its card: its own words, its own
 * pictures, its own model. The default form is the element itself and stays
 * first; the rest are added here, moved here, and taken away here.
 */
export function ElementVariantDialog({
  element,
  activeId,
  onClose,
  onSelect,
  onWrite,
}: {
  element: StoryElement;
  /** The form the card was showing, taken off the card when it leaves. */
  activeId?: string;
  onClose: () => void;
  onSelect: (variantId: string | null) => void;
  onWrite: (variants: StoryElementVariant[]) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const variants = element.variants ?? [];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const move = (at: number, by: number) => {
    const to = at + by;
    if (to < 0 || to >= variants.length) return;
    const next = [...variants];
    const [moved] = next.splice(at, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    onWrite(next);
  };

  const remove = (variant: StoryElementVariant) => {
    onWrite(variants.filter((held) => held.id !== variant.id));
    if (activeId === variant.id) onSelect(null);
  };

  const add = () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    const form = createElementVariant(element, trimmed);
    onWrite([...variants, form]);
    onSelect(form.id);
    setName("");
  };

  return createPortal(
    <div
      className="story-lightbox"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        aria-label={t("story:elements.formsTitle", { name: element.name })}
        aria-modal="true"
        className="story-variants"
        data-testid="story-element-forms"
        role="dialog"
      >
        <h2>{t("story:elements.formsTitle", { name: element.name })}</h2>
        <p className="story-hint">{t("story:elements.formsLead")}</p>

        <ol className="story-variant-list">
          <li className="story-variant-row is-default">
            <span className="story-variant-name">{element.name}</span>
            <span className="story-chip">
              {t("story:elements.defaultForm")}
            </span>
          </li>
          {variants.map((variant, at) => (
            <li
              className="story-variant-row"
              data-testid={`story-element-form-row-${variant.name}`}
              key={variant.id}
            >
              <span className="story-variant-name">{variant.name}</span>
              <span className="story-variant-actions">
                <button
                  aria-label={t("story:elements.formMoveUp", {
                    name: variant.name,
                  })}
                  className="link"
                  disabled={at === 0}
                  onClick={() => move(at, -1)}
                  type="button"
                >
                  ↑
                </button>
                <button
                  aria-label={t("story:elements.formMoveDown", {
                    name: variant.name,
                  })}
                  className="link"
                  disabled={at === variants.length - 1}
                  onClick={() => move(at, 1)}
                  type="button"
                >
                  ↓
                </button>
                <button
                  aria-label={t("story:elements.formRemove", {
                    name: variant.name,
                  })}
                  className="link"
                  data-testid={`story-element-form-remove-${variant.name}`}
                  onClick={() => remove(variant)}
                  type="button"
                >
                  {t("story:elements.formRemoveShort")}
                </button>
              </span>
            </li>
          ))}
        </ol>

        <div className="story-variant-add">
          <label className="dialog-field">
            <span>{t("story:elements.formName")}</span>
            <input
              data-testid="story-element-form-name"
              maxLength={STORY_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                add();
              }}
              placeholder={t("story:elements.formNameHint")}
              value={name}
            />
          </label>
          <button
            className="primary"
            data-testid="story-element-form-add"
            disabled={name.trim() === ""}
            onClick={add}
            type="button"
          >
            {t("story:elements.formAdd")}
          </button>
        </div>
        <p className="story-hint story-variant-note">
          {t("story:elements.formsNote")}
        </p>

        <div className="dialog-actions">
          <button
            data-testid="story-element-forms-close"
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
