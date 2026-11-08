import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  STORY_ELEMENT_KINDS,
  STORY_NAME_MAX,
  type StoryElementKind,
} from "../../../shared/domain";
import type { ElementDraft } from "./elementDraft";

/**
 * The form an element is typed into, wherever one is added: step three's cast
 * and the board's own reference row ask the same three things, and a new
 * character is the same new character in both places.
 */
export function ElementDraftDialog({
  title,
  note,
  confirm,
  initialKind = "character",
  onAdd,
  onCancel,
}: {
  title?: string;
  /** A line under the title about what adding here will do. */
  note?: string;
  confirm?: string;
  initialKind?: StoryElementKind;
  onAdd: (draft: ElementDraft) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<StoryElementKind>(initialKind);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const ready = name.trim() !== "" && description.trim() !== "";

  return (
    <div
      aria-label={title ?? t("story:elements.addTitle")}
      aria-modal="true"
      className="story-add-element"
      data-testid="add-element"
      role="dialog"
    >
      <h2>{title ?? t("story:elements.addTitle")}</h2>
      {note !== undefined && <p className="story-hint">{note}</p>}
      <label className="story-field-label" htmlFor="add-element-kind">
        {t("story:elements.kind")}
      </label>
      <select
        data-testid="add-element-kind"
        id="add-element-kind"
        onChange={(event) => setKind(event.target.value as StoryElementKind)}
        value={kind}
      >
        {STORY_ELEMENT_KINDS.map((each) => (
          <option key={each} value={each}>
            {t(`story:element.${each}`)}
          </option>
        ))}
      </select>
      <label className="story-field-label" htmlFor="add-element-name">
        {t("story:elements.name")}
      </label>
      <input
        data-testid="add-element-name"
        id="add-element-name"
        maxLength={STORY_NAME_MAX}
        onChange={(event) => setName(event.target.value)}
        value={name}
      />
      <label className="story-field-label" htmlFor="add-element-description">
        {t("story:elements.description")}
      </label>
      <textarea
        data-testid="add-element-description"
        id="add-element-description"
        maxLength={2000}
        onChange={(event) => setDescription(event.target.value)}
        rows={4}
        value={description}
      />
      <div className="dialog-actions">
        <button onClick={onCancel} type="button">
          {t("story:panels.cancel")}
        </button>
        <button
          className="primary"
          data-testid="add-element-confirm"
          disabled={!ready}
          onClick={() =>
            onAdd({
              kind,
              name: name.trim(),
              description: description.trim(),
            })
          }
          type="button"
        >
          {confirm ?? t("story:elements.addConfirm")}
        </button>
      </div>
    </div>
  );
}
