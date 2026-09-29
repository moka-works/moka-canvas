import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { assetThumbUrl } from "../../../api/assets";
import { currentTake, takeFile } from "../../../shared/domain/story";
import type { StorySlot } from "../../../shared/domain/types";
import { StoryLightbox } from "./StoryLightbox";
import { StoryPicks } from "./StoryPicks";

/** How wide a place's picture is asked for: it fills the panel and is
    enlarged — where the file itself is shown — in the lightbox. */
const SLOT_THUMB_WIDTH = 768;

/**
 * One place a drawing lives: a character's face, a character's four views, a
 * shot's frame.
 *
 * Every place in the room is one of these, so the pictures of step three and
 * step four look and behave the same — empty, being drawn, drawn — and a
 * reader learns the actions once. The card around it decides what the place is
 * called and what it is drawn from; this decides what may be done to it, and
 * nothing here writes to the document: the card hands over what an action
 * means for its own place.
 */
export function StorySlotView({
  slot,
  ratio,
  label,
  busy,
  canGenerate,
  disabledReason,
  onGenerate,
  onChoose,
  onRemove,
  note,
  actions,
  testId,
}: {
  slot: StorySlot;
  /** The shape of the place, as a CSS aspect ratio. */
  ratio: string;
  label: string;
  busy?: boolean;
  canGenerate: boolean;
  disabledReason?: string;
  onGenerate: () => void;
  onChoose: (assetId: string) => void;
  /** Throws an old drawing away, and answers the line to say about it. */
  onRemove: (assetId: string) => Promise<string | undefined>;
  /** A line under the picture, for what the place is waiting on. */
  note?: string;
  /** The card's own controls, in the row under the picture. */
  actions?: ReactNode;
  testId?: string;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const take = currentTake(slot);
  const many = slot.takes.length > 1;

  /** Choosing a take moves it to the head of the list, the rest as they were. */
  const choose = (assetId: string) => {
    onChoose(assetId);
    setPicking(false);
  };

  return (
    <div className="story-slot" data-testid={testId}>
      {take === undefined ? (
        <div
          className={`story-slot-empty${busy === true ? " is-busy" : ""}`}
          style={{ aspectRatio: ratio }}
        >
          {busy === true ? (
            <span className="story-slot-waiting" role="status">
              <span className="story-spin" />
              {t("story:panels.drawing")}
            </span>
          ) : (
            <>
              <span className="story-slot-label">{label}</span>
              <button
                className="link"
                data-testid={
                  testId === undefined ? undefined : `${testId}-generate`
                }
                disabled={!canGenerate}
                onClick={onGenerate}
                title={canGenerate ? undefined : disabledReason}
                type="button"
              >
                {t("story:panels.generate", { label })}
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="story-slot-drawn">
          <button
            aria-label={t("story:panels.enlarge", { label })}
            className="story-slot-picture"
            onClick={() => setZoomed(true)}
            style={{ aspectRatio: ratio }}
            type="button"
          >
            <img
              alt={label}
              src={assetThumbUrl(take.assetIds[0], SLOT_THUMB_WIDTH)}
            />
          </button>
          {busy === true && (
            // A picture being made again over the one it will replace: the
            // place says it is working on this picture and not on some other.
            <span className="story-slot-veil" role="status">
              <span className="story-spin" />
              {t("story:panels.drawing")}
            </span>
          )}
        </div>
      )}

      {take !== undefined && (
        <div className="story-slot-actions">
          <span className="story-slot-label">{label}</span>
          <button
            className="link"
            data-testid={testId === undefined ? undefined : `${testId}-again`}
            disabled={busy === true || !canGenerate}
            onClick={onGenerate}
            title={canGenerate ? undefined : disabledReason}
            type="button"
          >
            {busy === true
              ? t("story:panels.drawing")
              : t("story:panels.again")}
          </button>
          {many && (
            <button
              className="link"
              data-testid={testId === undefined ? undefined : `${testId}-pick`}
              onClick={() => setPicking(true)}
              type="button"
            >
              {t("story:panels.pick")}
            </button>
          )}
          {actions}
          {note !== undefined && <span className="story-hint">{note}</span>}
        </div>
      )}

      {picking && (
        <StoryPicks
          current={takeFile(take)}
          label={label}
          onChoose={choose}
          onClose={() => setPicking(false)}
          onRemove={onRemove}
          takes={slot.takes}
        />
      )}
      {zoomed && take !== undefined && (
        <StoryLightbox
          assetIds={[take.assetIds[0]]}
          label={`${label}${note === undefined ? "" : ` · ${note}`}`}
          onClose={() => setZoomed(false)}
        />
      )}
    </div>
  );
}
