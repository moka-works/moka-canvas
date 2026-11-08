import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { assetThumbUrl } from "../../../api/assets";
import { currentTake, elementForm, takeFile } from "../../../shared/domain";
import type { StoryDocument, StoryElement } from "../../../shared/domain/types";
import { planElementArtWaves } from "../jobs/plan";
import { useStoryJobs, useStoryWavesAsk } from "../stores/storyJobStore";
import { useStoryStore } from "../stores/storyStore";
import {
  chooseElementTake,
  keepElementPicture,
  uploadElementPicture,
  type ElementView,
} from "./elementPictures";
import { relativeTime } from "../relativeTime";
import { StoryLibraryPicker } from "./StoryLibraryPicker";
import { StoryEditDialog } from "./StoryEditDialog";

/** How wide the inspector's own picture is asked for: the stage is a window
    wide, and the thumbnail beside it is a version at a glance. */
const STAGE_THUMB_WIDTH = 960;
const VERSION_THUMB_WIDTH = 160;

/**
 * One element's picture, as the board looks at it: the drawing itself, every
 * take it has been given, and the four things that may be done to it — drawn
 * again, taken from the shelf, taken from this computer, or opened on the card
 * whose description every drawing is made from.
 *
 * The board shows the pictures an act is made of, so fixing a reference is a
 * thing done where the wrong one is noticed rather than a walk to step three
 * and back. The card is still the door to the words: the inspector hands the
 * reader over to it, on that very card, when what needs changing is a
 * description rather than a drawing.
 */
export function ElementPictureInspector({
  story,
  element,
  view = "main",
  variantId,
  onVariant,
  onClose,
}: {
  story: StoryDocument;
  element: StoryElement;
  view?: ElementView;
  /** The form being looked at; absent means the element's default form. */
  variantId?: string;
  /** Switches the form this picture stands for, where the picture is a shot's. */
  onVariant?: (variantId: string | undefined) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const run = useStoryWavesAsk();
  const jobs = useStoryJobs(story.id);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const variant = elementForm(element, variantId);
  const description =
    variant === undefined ? element.description : variant.description;
  const slot =
    view === "main"
      ? (variant?.main ?? element.main)
      : (variant?.turnaround ?? element.turnaround ?? EMPTY);
  const take = currentTake(slot);
  const canGenerate =
    view === "main" || currentTake(variant?.main ?? element.main) !== undefined;
  const busy = useMemo(
    () =>
      jobs.some(
        (job) =>
          (job.status === "queued" || job.status === "running") &&
          job.items.some(
            (item) =>
              (item.status === "queued" || item.status === "running") &&
              item.target.kind === "elementArt" &&
              item.target.elementId === element.id &&
              item.target.view === view &&
              item.target.variantId === variant?.id,
          ),
      ),
    [jobs, element.id, view, variant?.id],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const generate = () => {
    void run(
      story.id,
      "elementArt",
      planElementArtWaves(story, [
        {
          elementId: element.id,
          view,
          ...(variant === undefined ? {} : { variantId: variant.id }),
        },
      ]),
    );
  };

  // The edit dialog takes the inspector's place while it stands: two dark
  // veils over the board, one under the other, is a dialog nobody can press.
  // Closing it hands the reader back to the reference they were looking at.
  if (editing) {
    return (
      <StoryEditDialog
        onClose={() => setEditing(false)}
        place={{ kind: "element", element, view, variant }}
        story={story}
      />
    );
  }

  return createPortal(
    <div
      className="story-lightbox"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        aria-label={t("story:inspector.label", { name: element.name })}
        aria-modal="true"
        className="story-inspector"
        data-testid="story-picture-inspector"
        role="dialog"
      >
        <header className="story-inspector-head">
          <div className="story-inspector-title">
            <h2>
              {variant === undefined
                ? element.name
                : `${element.name} · ${variant.name}`}
            </h2>
            <span className="story-element-kind">
              {t(`story:element.${element.kind}`)}
            </span>
            {onVariant !== undefined && (element.variants?.length ?? 0) > 0 && (
              <select
                aria-label={t("story:elements.form")}
                className="story-inspector-form"
                data-testid="story-inspector-form"
                onChange={(event) =>
                  onVariant(
                    event.target.value === "" ? undefined : event.target.value,
                  )
                }
                value={variant?.id ?? ""}
              >
                <option value="">{t("story:elements.defaultForm")}</option>
                {(element.variants ?? []).map((held) => (
                  <option key={held.id} value={held.id}>
                    {held.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <button
            aria-label={t("story:panels.close")}
            className="link"
            data-testid="story-inspector-close"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </header>
        <p className="story-hint story-inspector-description">
          {description.trim() === ""
            ? t("story:inspector.noDescription")
            : description}
        </p>

        <div className="story-inspector-body">
          <div className="story-inspector-stage">
            {take === undefined ? (
              <div className="story-slot-empty story-inspector-empty">
                <span>{t("story:inspector.noArt")}</span>
                <span className="story-hint">
                  {t("story:inspector.emptyHint")}
                </span>
              </div>
            ) : (
              <img
                alt={element.name}
                decoding="async"
                src={assetThumbUrl(take.assetIds[0] ?? "", STAGE_THUMB_WIDTH)}
              />
            )}
            {busy && (
              <span className="story-slot-veil" role="status">
                <span className="story-spin" />
                {t("story:panels.drawing")}
              </span>
            )}
          </div>

          <div className="story-inspector-side">
            <div className="story-inspector-actions">
              <button
                className="primary"
                data-testid="story-inspector-again"
                disabled={busy || !canGenerate}
                onClick={generate}
                type="button"
              >
                {busy ? t("story:panels.drawing") : t("story:panels.again")}
              </button>
              <button
                data-testid="story-inspector-edit"
                disabled={take === undefined || busy}
                onClick={() => setEditing(true)}
                type="button"
              >
                {t("story:panels.edit")}
              </button>
              <button
                data-testid="story-inspector-library"
                onClick={() => setPicking(true)}
                type="button"
              >
                {t("story:panels.fromLibrary")}
              </button>
              <button
                data-testid="story-inspector-file"
                onClick={() => file.current?.click()}
                type="button"
              >
                {t("story:panels.fromFile")}
              </button>
              <input
                accept="image/*"
                data-testid="story-inspector-file-input"
                hidden
                onChange={(event) => {
                  const chosen = event.target.files?.[0];
                  event.target.value = "";
                  if (chosen !== undefined) {
                    void uploadElementPicture(
                      story,
                      element,
                      view,
                      chosen,
                      variant?.id,
                    );
                  }
                }}
                ref={file}
                type="file"
              />
              <button
                className="link"
                data-testid="story-inspector-open-card"
                onClick={() => {
                  useStoryStore.getState().focusElement(element.id);
                  onClose();
                }}
                type="button"
              >
                {t("story:inspector.openCard")}
              </button>
            </div>

            <div className="story-inspector-versions">
              <span className="story-hint">
                {t("story:inspector.versions")}
              </span>
              {slot.takes.length === 0 ? (
                <span className="story-hint">{t("story:inspector.noArt")}</span>
              ) : (
                <div className="story-version-strip">
                  {slot.takes.map((held, at) => {
                    const current = at === slot.takes.length - 1;
                    return (
                      <button
                        aria-pressed={current}
                        className={`story-version${current ? " is-current" : ""}`}
                        data-testid={`story-version-${at}`}
                        key={`${held.assetIds[0] ?? at}-${at}`}
                        onClick={() =>
                          chooseElementTake(
                            story,
                            element,
                            view,
                            held.assetIds[0] ?? "",
                            variant?.id,
                          )
                        }
                        title={held.createdAt}
                        type="button"
                      >
                        <img
                          alt=""
                          decoding="async"
                          loading="lazy"
                          src={assetThumbUrl(
                            held.assetIds[0] ?? "",
                            VERSION_THUMB_WIDTH,
                          )}
                        />
                        <span>
                          {current
                            ? t("story:inspector.current")
                            : relativeTime(held.createdAt)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {picking && (
        <StoryLibraryPicker
          current={takeFile(take)}
          label={t(
            view === "main"
              ? "story:elements.main"
              : "story:elements.turnaround",
          )}
          onChoose={(assetId) => {
            keepElementPicture(story, element, view, assetId, variant?.id);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>,
    document.body,
  );
}

/** A place a character has not been given yet, for the inspector's own read. */
const EMPTY = { takes: [] };
