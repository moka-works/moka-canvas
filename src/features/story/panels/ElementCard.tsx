import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  STORY_NAME_MAX,
  currentTake,
  elementOf,
  slotWithoutTake,
  slotWithCurrent,
} from "../../../shared/domain";
import type {
  StoryChapter,
  StoryDocument,
  StoryElement,
  StoryElementPatch,
  StorySlot,
} from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { planElementArt, resolveVoice } from "../jobs/plan";
import { useStoryRun } from "../stores/storyJobStore";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { frameRatio } from "./ratios";
import { liveStory, removeOldTake, type TakeDrop } from "./removeOldTake";
import { StorySlotView } from "./StorySlotView";
import { useField } from "./useField";
import { VoiceFields } from "./VoiceFields";

/** A place with nothing in it, for a slot a character has not been given yet. */
const EMPTY_SLOT: StorySlot = { takes: [] };

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
export function ElementCard({
  story,
  element,
  busyMain,
  busyTurnaround,
}: {
  story: StoryDocument;
  element: StoryElement;
  /** Whether this element's own picture is being drawn just now. */
  busyMain: boolean;
  /** Whether this element's four views are being drawn just now. */
  busyTurnaround: boolean;
}) {
  const { t } = useTranslation();
  const [removing, setRemoving] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const run = useStoryRun();
  const main = currentTake(element.main);
  const character = element.kind === "character";
  const description = useField(element.description, (value) => {
    if (value !== element.description)
      write(story, element, { description: value });
  });
  const named = useField(element.name, (value) => {
    const name = value.trim();
    // A name nobody could read is not a name: the element keeps the one it had.
    if (name !== "" && name !== element.name) write(story, element, { name });
  });
  const ratio = frameRatio(story);

  const generate = (view: "main" | "turnaround") => {
    const [item] = planElementArt(story, [{ elementId: element.id, view }]);
    if (item === undefined) return;
    void run(story.id, "elementArt", [item]);
  };

  return (
    <li
      className="story-element"
      data-testid={`story-element-${element.kind}-${element.name}`}
    >
      <div className="story-element-pictures">
        <StorySlotView
          busy={busyMain}
          canGenerate
          label={t("story:elements.main")}
          onChoose={(assetId) => choose(story, element, "main", assetId)}
          onGenerate={() => generate("main")}
          onRemove={(assetId) =>
            removeOldTake(assetId, () =>
              dropTake(story, element.id, "main", assetId),
            )
          }
          ratio={ratio}
          slot={element.main}
          testId="story-slot-main"
        />
        {character && (
          <StorySlotView
            busy={busyTurnaround}
            canGenerate={main !== undefined}
            disabledReason={
              main === undefined ? t("story:elements.needMainFirst") : undefined
            }
            label={t("story:elements.turnaround")}
            note={t("story:elements.turnaroundFour")}
            onChoose={(assetId) =>
              choose(story, element, "turnaround", assetId)
            }
            onGenerate={() => generate("turnaround")}
            onRemove={(assetId) =>
              removeOldTake(assetId, () =>
                dropTake(story, element.id, "turnaround", assetId),
              )
            }
            ratio="1 / 1"
            slot={element.turnaround ?? EMPTY_SLOT}
            testId="story-slot-turnaround"
          />
        )}
      </div>

      <div className="story-element-head">
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
        <button
          aria-label={t("story:elements.remove", { name: element.name })}
          className="story-element-remove"
          data-testid={`story-element-remove-${element.name}`}
          onClick={() => setRemoving(true)}
          type="button"
        >
          ✕
        </button>
      </div>

      <ChapterLine
        chapters={story.chapters}
        chosen={element.chapterIds}
        name={element.name}
        onPick={(chapterIds) => write(story, element, { chapterIds })}
        open={chaptersOpen}
        setOpen={setChaptersOpen}
      />

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

      {character && (
        <VoiceFields
          characterId={element.id}
          fallbackVoice={resolveVoice(story, element.id)}
          onWrite={(voice) => write(story, element, { voice })}
          story={story}
          testId={`story-voice-${element.name}`}
          voice={element.voice}
        />
      )}

      <div className="story-element-actions">
        <span className="story-hint">{t("story:elements.rewriteText")}</span>
      </div>

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
}

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
  return (
    <div className="story-element-chapters">
      {chosen.length === 0 ? (
        <span className="story-hint">{t("story:elements.anyChapter")}</span>
      ) : (
        chapters.map((chapter, index) =>
          chosen.includes(chapter.id) ? (
            <span className="story-chip" key={chapter.id}>
              {t("story:elements.chapter", { number: index + 1 })}
            </span>
          ) : null,
        )
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

/** One of an element's two pictures, whole, as the reader leaves it. */
function writeSlot(
  story: StoryDocument,
  element: StoryElement,
  view: "main" | "turnaround",
  slot: StorySlot,
) {
  return execute(i18n.t("story:history.elements"), [
    {
      type: "setStorySlot",
      storyId: story.id,
      target: { kind: "element", elementId: element.id, view },
      slot,
    },
  ]);
}

/** Keeps the take a reader picked, and lets the older ones go on being there. */
function choose(
  story: StoryDocument,
  element: StoryElement,
  view: "main" | "turnaround",
  assetId: string,
): void {
  const slot = view === "main" ? element.main : element.turnaround;
  if (slot === undefined) return;
  writeSlot(story, element, view, slotWithCurrent(slot, assetId));
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
): TakeDrop {
  const live = liveStory(story.id);
  const element = live === undefined ? undefined : elementOf(live, elementId);
  const slot = view === "main" ? element?.main : element?.turnaround;
  if (live === undefined || element === undefined || slot === undefined)
    return "gone";
  const without = slotWithoutTake(slot, assetId);
  if (without === slot) return "gone";
  return writeSlot(live, element, view, without) === null
    ? "refused"
    : "dropped";
}

/** Takes an element out of the story, leaving the pictures it was drawn in. */
function removeElement(story: StoryDocument, elementId: string): void {
  execute(i18n.t("story:history.elements"), [
    {
      type: "setStoryElements",
      storyId: story.id,
      elements: story.elements.filter((held) => held.id !== elementId),
    },
  ]);
}
