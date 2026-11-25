import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { assetUrl } from "../../../api/assets";
import { takeFile } from "../../../shared/domain/story";
import type { StoryTake } from "../../../shared/domain/types";

/**
 * The drawings one ask made together, looked at side by side before one is
 * kept.
 *
 * A set drawn at once is one decision, so every picture of it stands here as
 * large as the window takes, and the reader says which one the place keeps.
 * Confirming keeps all of them — the chosen one in use — so a picture that was
 * nearly chosen is still there to come back to.
 */
export function StoryCandidateDialog({
  label,
  name,
  description,
  candidates,
  onChoose,
  onClose,
}: {
  label: string;
  /** The element these drawings belong to, named in the title where there is one. */
  name?: string;
  /** What the drawings were made from, standing under the title to choose by. */
  description?: string;
  candidates: StoryTake[];
  onChoose: (assetId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<string | undefined>(() =>
    takeFile(candidates[0]),
  );
  const heading =
    name === undefined
      ? t("story:panels.candidates")
      : t("story:panels.candidatesFor", { label, name });

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
        aria-label={heading}
        aria-modal="true"
        className="story-candidates"
        data-testid="story-candidates"
        role="dialog"
      >
        <header className="story-candidates-head">
          <div>
            <h2>{heading}</h2>
            {description !== undefined && description.trim() !== "" && (
              <p
                className="story-candidates-description"
                data-testid="story-candidates-description"
              >
                {description}
              </p>
            )}
            <p className="story-hint">
              {t("story:panels.candidatesHint", { label })}
            </p>
          </div>
          <button
            aria-label={t("story:panels.close")}
            className="dialog-close"
            data-testid="story-candidates-close"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </header>
        <div className="story-candidates-grid">
          {candidates.map((take, at) => {
            const file = takeFile(take);
            if (file === undefined) return null;
            const active = file === picked;
            return (
              <button
                aria-pressed={active}
                className={`story-candidate${active ? " is-picked" : ""}`}
                data-testid={`story-candidate-${at}`}
                key={`${file}-${at}`}
                onClick={() => setPicked(file)}
                type="button"
              >
                <img alt={`${label} ${at + 1}`} src={assetUrl(file)} />
                <span className="story-candidate-foot">
                  {t("story:panels.candidateAt", { at: at + 1 })}
                  {active && (
                    <span className="story-pick-current">
                      {t("story:panels.candidatePicked")}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        <div className="dialog-actions">
          <button onClick={onClose} type="button">
            {t("story:panels.cancel")}
          </button>
          <button
            className="primary"
            data-testid="story-candidates-confirm"
            disabled={picked === undefined}
            onClick={() => {
              if (picked !== undefined) onChoose(picked);
            }}
            type="button"
          >
            {t("story:panels.candidateKeep")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
