import { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  ASPECT_LABELS,
  STORY_ASPECTS,
  STORY_NAME_MAX,
  currentTake,
  elementForm,
  elementOf,
  slotWithoutTake,
  targetKey,
  voiceNamed,
} from "../../../shared/domain";
import type {
  StoryAspect,
  StoryChapter,
  StoryDocument,
  StoryElement,
  StoryElementPatch,
  StorySlot,
} from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { ModelPicker } from "../../settings/ModelPicker";
import { planElementArtWaves, resolveVoice } from "../jobs/plan";
import { useStoryWavesAsk } from "../stores/storyJobStore";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { elementRatio } from "./ratios";
import {
  chooseElementTake,
  keepElementPicture,
  uploadElementPicture,
  writeElementSlot,
} from "./elementPictures";
import { liveStory, removeOldTake, type TakeDrop } from "./removeOldTake";
import { StoryEditDialog } from "./StoryEditDialog";
import { StoryLibraryPicker } from "./StoryLibraryPicker";
import { StorySlotView } from "./StorySlotView";
import { ElementVariantDialog } from "./ElementVariantDialog";
import { useField } from "./useField";
import { VoiceFields } from "./VoiceFields";

/** A place with nothing in it, for a slot a character has not been given yet. */
const EMPTY_SLOT: StorySlot = { takes: [] };

/** How many chapters a card lists before the rest are left to the menu. */
const CHAPTER_CHIPS = 2;

/** The form picker's item that opens the dialog rather than choosing a form. */
const MANAGE_FORMS = "__manage__";

/**
 * One character, a place or a thing, as the room holds it.
 *
 * The card is a container: everything about the pictures belongs to the slot
 * views above the words, and what is written here is the element's own — its
 * name, the chapters it stands in, and the description every drawing of it is
 * made from. The words stay the reader's to rewrite for as long as the telling
 * is being worked on; what settles the step is its own confirm, not a press
 * per element.
 */
export const ElementCard = memo(function ElementCard({
  story,
  element,
  busyTargets,
  selected,
  onSelect,
  focused,
}: {
  story: StoryDocument;
  element: StoryElement;
  /** The places the story's batches are making just now, by target key. */
  busyTargets: Set<string>;
  /** Whether the card is among those a bulk action is about. */
  selected: boolean;
  onSelect: (elementId: string, selected: boolean) => void;
  /** Whether a jump from another step asked for this card to be in view. */
  focused?: boolean;
}) {
  const { t } = useTranslation();
  const [removing, setRemoving] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  // The form the card is showing: the element's own, or one of its variants.
  const [formId, setFormId] = useState<string | null>(null);
  // The dialog that adds forms, orders them, and takes them away.
  const [managing, setManaging] = useState(false);
  // The voice is a card's least used form, and every one of them is a model
  // picker and a recording row: it is kept folded until the reader opens it.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // The place whose picture is being taken from the project's own shelf.
  const [picking, setPicking] = useState<"main" | "turnaround" | null>(null);
  // The place whose picture is being changed rather than drawn again.
  const [editing, setEditing] = useState<"main" | "turnaround" | null>(null);
  const run = useStoryWavesAsk();
  const variants = element.variants ?? [];
  const variant = elementForm(element, formId ?? undefined);
  const mainSlot = variant === undefined ? element.main : variant.main;
  const turnaroundSlot =
    variant === undefined ? element.turnaround : variant.turnaround;
  const activeModel =
    variant === undefined ? element.imageModel : variant.imageModel;
  const activeRatio = variant === undefined ? element.ratio : variant.ratio;
  const activeDescription =
    variant === undefined ? element.description : variant.description;
  const main = currentTake(mainSlot);
  const character = element.kind === "character";
  const description = useField(activeDescription, (value) => {
    if (value !== activeDescription) writeForm({ description: value });
  });
  const named = useField(element.name, (value) => {
    const name = value.trim();
    // A name nobody could read is not a name: the element keeps the one it had.
    if (name !== "" && name !== element.name) write(story, element, { name });
  });
  const ratio = elementRatio(story, element, variant);
  const formTarget = (view: "main" | "turnaround") =>
    targetKey({
      kind: "element",
      elementId: element.id,
      view,
      ...(variant === undefined ? {} : { variantId: variant.id }),
    });
  const busyMain = busyTargets.has(formTarget("main"));
  const busyTurnaround = busyTargets.has(formTarget("turnaround"));

  /** Writes the form's own words or settings: the default form's, or a variant's. */
  const writeForm = (patch: {
    description?: string;
    imageModel?: string | null;
    ratio?: StoryAspect | null;
  }) => {
    if (variant === undefined) {
      write(story, element, patch);
      return;
    }
    writeVariants(
      story,
      element,
      variants.map((held) =>
        held.id === variant.id
          ? {
              ...held,
              ...(patch.description !== undefined
                ? { description: patch.description }
                : {}),
              ...(patch.imageModel !== undefined
                ? {
                    imageModel:
                      patch.imageModel === null ? undefined : patch.imageModel,
                  }
                : {}),
              ...(patch.ratio !== undefined
                ? {
                    ratio: patch.ratio === null ? undefined : patch.ratio,
                  }
                : {}),
            }
          : held,
      ),
    );
  };

  const generate = (view: "main" | "turnaround") => {
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

  return (
    <li
      className={`story-element${focused === true ? " is-focused" : ""}`}
      data-element-id={element.id}
      data-testid={`story-element-${element.kind}-${element.name}`}
    >
      <div className="story-element-head">
        <input
          aria-label={t("story:elements.select", { name: element.name })}
          checked={selected}
          className="story-element-select"
          data-testid={`story-element-select-${element.name}`}
          onChange={(event) => onSelect(element.id, event.target.checked)}
          type="checkbox"
        />
        <span className="story-element-kind">
          {t(`story:element.${element.kind}`)}
        </span>
        <input
          aria-label={t("story:elements.name")}
          className="story-element-name"
          data-testid={`story-element-name-${element.name}`}
          maxLength={STORY_NAME_MAX}
          onBlur={named.commit}
          onChange={(event) => named.set(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            named.commit();
          }}
          value={named.value}
        />
        <select
          aria-label={t("story:elements.form")}
          className="story-element-form"
          data-testid={`story-element-form-${element.name}`}
          onChange={(event) => {
            if (event.target.value === MANAGE_FORMS) {
              setManaging(true);
              return;
            }
            setFormId(event.target.value === "" ? null : event.target.value);
          }}
          value={variant?.id ?? ""}
        >
          <option value="">{t("story:elements.defaultForm")}</option>
          {variants.map((held) => (
            <option key={held.id} value={held.id}>
              {held.name}
            </option>
          ))}
          <option value={MANAGE_FORMS}>
            {t("story:elements.manageForms")}
          </option>
        </select>
      </div>

      <div className="story-element-pictures">
        <StorySlotView
          actions={
            <button
              className="link"
              data-testid="story-slot-edit-main"
              onClick={() => setEditing("main")}
              type="button"
            >
              {t("story:panels.edit")}
            </button>
          }
          busy={busyMain}
          canGenerate
          label={t("story:elements.main")}
          onChoose={(assetId) =>
            chooseElementTake(story, element, "main", assetId, variant?.id)
          }
          onGenerate={() => generate("main")}
          onPickFromLibrary={() => setPicking("main")}
          onUpload={(file) =>
            void uploadElementPicture(story, element, "main", file, variant?.id)
          }
          onRemove={(assetId) =>
            removeOldTake(assetId, () =>
              dropTake(story, element.id, "main", assetId, variant?.id),
            )
          }
          ratio={ratio}
          slot={mainSlot}
          testId="story-slot-main"
        />
        {character && (
          <StorySlotView
            actions={
              <button
                className="link"
                data-testid="story-slot-edit-turnaround"
                onClick={() => setEditing("turnaround")}
                type="button"
              >
                {t("story:panels.edit")}
              </button>
            }
            busy={busyTurnaround}
            canGenerate={main !== undefined}
            disabledReason={
              main === undefined ? t("story:elements.needMainFirst") : undefined
            }
            label={t("story:elements.turnaround")}
            note={t("story:elements.turnaroundFour")}
            onChoose={(assetId) =>
              chooseElementTake(
                story,
                element,
                "turnaround",
                assetId,
                variant?.id,
              )
            }
            onGenerate={() => generate("turnaround")}
            onPickFromLibrary={() => setPicking("turnaround")}
            onUpload={(file) =>
              void uploadElementPicture(
                story,
                element,
                "turnaround",
                file,
                variant?.id,
              )
            }
            onRemove={(assetId) =>
              removeOldTake(assetId, () =>
                dropTake(story, element.id, "turnaround", assetId, variant?.id),
              )
            }
            ratio="1 / 1"
            slot={turnaroundSlot ?? EMPTY_SLOT}
            testId="story-slot-turnaround"
          />
        )}
      </div>

      <ChapterLine
        chapters={story.chapters}
        chosen={element.chapterIds}
        name={element.name}
        onPick={(chapterIds) => write(story, element, { chapterIds })}
        open={chaptersOpen}
        setOpen={setChaptersOpen}
      />

      <div className="story-element-fields">
        <div
          className="story-element-model"
          data-testid={`story-element-model-${element.name}`}
        >
          <ModelPicker
            capability="image"
            label={t("story:elements.imageModel")}
            noneLabel={t("story:elements.imageModelNone")}
            onChange={(reference) => writeForm({ imageModel: reference })}
            value={activeModel ?? null}
          />
        </div>
        {element.kind === "prop" && (
          <label
            className="dialog-field story-element-ratio"
            data-testid={`story-element-ratio-${element.name}`}
          >
            <span>{t("story:elements.ratio")}</span>
            <select
              onChange={(event) =>
                writeForm({
                  ratio:
                    event.target.value === "1:1"
                      ? null
                      : (event.target.value as StoryAspect),
                })
              }
              value={activeRatio ?? "1:1"}
            >
              {STORY_ASPECTS.map((aspect) => (
                <option key={aspect} value={aspect}>
                  {t(ASPECT_LABELS[aspect])}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <textarea
        aria-label={t("story:elements.description")}
        className="story-element-description"
        data-testid={`story-element-description-${element.name}`}
        maxLength={2000}
        onBlur={description.commit}
        onChange={(event) => description.set(event.target.value)}
        rows={4}
        value={description.value}
      />

      {character && variant === undefined && (
        <div className="story-element-advanced">
          <button
            aria-expanded={advancedOpen}
            className="link"
            data-testid={`story-element-advanced-${element.name}`}
            onClick={() => setAdvancedOpen(!advancedOpen)}
            type="button"
          >
            {t("story:elements.advanced")}
            {voiceNamed(element.voice)
              ? ` · ${t("story:elements.voiceSet")}`
              : ""}
          </button>
          {advancedOpen && (
            <VoiceFields
              characterId={element.id}
              fallbackVoice={resolveVoice(story, element.id)}
              onWrite={(voice) => write(story, element, { voice })}
              story={story}
              testId={`story-voice-${element.name}`}
              voice={element.voice}
            />
          )}
        </div>
      )}

      <div className="story-element-actions">
        <span className="story-hint">{t("story:elements.rewriteText")}</span>
        <button
          className="link"
          data-testid={`story-element-remove-${element.name}`}
          onClick={() => setRemoving(true)}
          type="button"
        >
          {t("story:elements.remove")}
        </button>
      </div>

      {picking !== null && (
        <StoryLibraryPicker
          current={
            currentTake(
              picking === "main" ? mainSlot : (turnaroundSlot ?? EMPTY_SLOT),
            )?.assetIds[0]
          }
          label={t(
            picking === "main"
              ? "story:elements.main"
              : "story:elements.turnaround",
          )}
          onChoose={(assetId) => {
            keepElementPicture(story, element, picking, assetId, variant?.id);
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      )}

      {editing !== null && (
        <StoryEditDialog
          onClose={() => setEditing(null)}
          place={{ kind: "element", element, view: editing, variant }}
          story={story}
        />
      )}

      {managing && (
        <ElementVariantDialog
          activeId={variant?.id}
          element={element}
          onClose={() => setManaging(false)}
          onSelect={setFormId}
          onWrite={(next) => writeVariants(story, element, next)}
        />
      )}

      {removing && (
        <ConfirmDialog
          body={t("story:elements.removeBody", { name: element.name })}
          confirm={t("story:elements.removeConfirm")}
          note={t("story:elements.removeNote")}
          onCancel={() => setRemoving(false)}
          onConfirm={() => {
            setRemoving(false);
            removeElement(story, element.id);
          }}
          testId="remove-element"
          title={t("story:elements.removeTitle", { name: element.name })}
        />
      )}
    </li>
  );
});

/** The chapters an element stands in: what it is, and the list to change it. */
function ChapterLine({
  chapters,
  chosen,
  name,
  open,
  setOpen,
  onPick,
}: {
  chapters: StoryChapter[];
  chosen: string[];
  name: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  onPick: (chapterIds: string[]) => void;
}) {
  const { t } = useTranslation();
  // The chapters are listed in telling order, two at a time: the button
  // beside them opens the whole list, so a card in a long telling stays short.
  const standing = chapters.flatMap((chapter, index) =>
    chosen.includes(chapter.id) ? [{ chapter, number: index + 1 }] : [],
  );
  return (
    <div className="story-element-chapters">
      {standing.length === 0 ? (
        <span className="story-hint">{t("story:elements.anyChapter")}</span>
      ) : (
        <>
          {standing.slice(0, CHAPTER_CHIPS).map(({ chapter, number }) => (
            <span className="story-chip" key={chapter.id}>
              {t("story:elements.chapter", { number })}
            </span>
          ))}
          {standing.length > CHAPTER_CHIPS && (
            <span
              className="story-chip"
              data-testid={`story-element-chapters-more-${name}`}
              title={t("story:elements.moreChapters", {
                count: standing.length - CHAPTER_CHIPS,
              })}
            >
              …
            </span>
          )}
        </>
      )}
      <button
        className="link"
        data-testid={`story-element-chapters-${name}`}
        onClick={() => setOpen(!open)}
        type="button"
      >
        {t("story:elements.whichChapters")}
      </button>
      {open && (
        <div
          aria-label={t("story:elements.chaptersMenu")}
          className="story-chapter-menu"
          data-testid="story-element-chapters-menu"
          role="menu"
        >
          {chapters.map((chapter, index) => (
            <button
              aria-checked={chosen.includes(chapter.id)}
              className={`story-chapter-choice${chosen.includes(chapter.id) ? " is-on" : ""}`}
              key={chapter.id}
              onClick={() =>
                onPick(
                  chosen.includes(chapter.id)
                    ? chosen.filter((held) => held !== chapter.id)
                    : [...chosen, chapter.id],
                )
              }
              role="menuitemcheckbox"
              type="button"
            >
              {index + 1}. {chapter.title}
            </button>
          ))}
          <button className="link" onClick={() => setOpen(false)} type="button">
            {t("story:panels.close")}
          </button>
        </div>
      )}
    </div>
  );
}

/** One element's field, written as one step of the history. */
function write(
  story: StoryDocument,
  element: StoryElement,
  patch: StoryElementPatch,
): void {
  execute(i18n.t("story:history.elements"), [
    {
      type: "updateStoryElement",
      storyId: story.id,
      elementId: element.id,
      patch,
    },
  ]);
}

/**
 * One element's forms, whole, as one step of the history.
 *
 * Written whole rather than one form at a time: adding, removing and arranging
 * are one act of the reader's, and the undo of any of them is the list as it
 * stood before the press.
 */
function writeVariants(
  story: StoryDocument,
  element: StoryElement,
  variants: StoryElement["variants"],
): void {
  execute(i18n.t("story:history.elements"), [
    {
      type: "updateStoryElement",
      storyId: story.id,
      elementId: element.id,
      patch: { variants: variants ?? [] },
    },
  ]);
}

/**
 * One of an element's drawings dropped from its place, as the live document
 * holds that place: a slot is written whole, so a slot read off the card's
 * render would put back whatever a job landed while the picks dialog stood
 * open.
 */
function dropTake(
  story: StoryDocument,
  elementId: string,
  view: "main" | "turnaround",
  assetId: string,
  variantId?: string,
): TakeDrop {
  const live = liveStory(story.id);
  const element = live === undefined ? undefined : elementOf(live, elementId);
  const form =
    element === undefined || variantId === undefined
      ? undefined
      : elementForm(element, variantId);
  const slot =
    element === undefined
      ? undefined
      : variantId !== undefined
        ? form === undefined
          ? undefined
          : view === "main"
            ? form.main
            : form.turnaround
        : view === "main"
          ? element.main
          : element.turnaround;
  if (live === undefined || element === undefined || slot === undefined)
    return "gone";
  const without = slotWithoutTake(slot, assetId);
  if (without === slot) return "gone";
  return writeElementSlot(live, element, view, without, variantId)
    ? "dropped"
    : "refused";
}

/** Takes an element out of the story, leaving the pictures it was drawn in. */
function removeElement(story: StoryDocument, elementId: string): void {
  // Read the live document rather than the card's render: the card may have
  // been on screen since before an answer landed, and writing its snapshot
  // back would quietly undo what the reader has said or a batch has filed.
  const live = liveStory(story.id) ?? story;
  execute(i18n.t("story:history.removeElement"), [
    {
      type: "setStoryElements",
      storyId: story.id,
      elements: live.elements.filter((held) => held.id !== elementId),
    },
  ]);
}
