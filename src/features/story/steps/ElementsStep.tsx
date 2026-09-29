import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  STORY_ELEMENT_KINDS,
  STORY_NAME_MAX,
  chapterWaves,
  currentTake,
  elementDescribed,
  targetKey,
  voiceNamed,
  type StoryDocument,
  type StoryElement,
  type StoryElementKind,
} from "../../../shared/domain";
import { MAX_ELEMENTS_PER_STORY } from "../../../shared/domain/constants";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { SHELF_PAGE } from "../../editor/panels/shelfFilter";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StoryModelPicks } from "../components/StoryModelPicks";
import { StoryImportButton } from "../components/StoryImportButton";
import { StepConfirm } from "../components/StepConfirm";
import { ElementCard } from "../panels/ElementCard";
import { VoiceFields } from "../panels/VoiceFields";
import { readElementsAnswer } from "../jobs/apply";
import {
  planElementArt,
  planElements,
  resolveVoice,
  storyReadChars,
} from "../jobs/plan";
import {
  jobProgress,
  kindRunning,
  targetRunning,
  useRunningJob,
  useStoryJobs,
  useStoryJobStore,
  useStoryRun,
} from "../stores/storyJobStore";

/** The kinds of element, in the order the room shows them. */
const KINDS: StoryElementKind[] = ["character", "scene", "prop"];

const EMPTY = { takes: [] };

/**
 * The third step: who and what the telling is made of.
 *
 * The chapters are read once for the characters, places and things they hold;
 * each of them is then described and drawn, and the descriptions stay the
 * reader's to rewrite for as long as the telling is being worked on. Nothing is
 * asked for in bulk without saying how many pieces it is — a shelf of drawings
 * is minutes of a provider's time.
 *
 * Every picture is an ask of its own: a card whose painter is working says so
 * and is not asked for twice, while the cards beside it go on being drawable.
 * The one thing that waits on the whole story is a reading, which writes the
 * cast every card stands in.
 *
 * A telling too long to read in one ask is read a part at a time, and what a
 * part finds is added to what the parts before it found.
 */
export function ElementsStep({ story }: { story: StoryDocument }) {
  const { t } = useTranslation();
  const jobs = useStoryJobs(story.id);
  const running = useRunningJob(story.id);
  const failure = useStoryJobStore((state) => state.error);
  const run = useStoryRun();
  const [kind, setKind] = useState<StoryElementKind | "all">("all");
  const [asking, setAsking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pages, setPages] = useState(1);
  const [waves, setWaves] = useState<string[][]>([]);
  const [totalWaves, setTotalWaves] = useState(0);
  // A batch is being handed over, whether for the first part or a later one.
  const sending = useStoryJobStore((state) => state.starting);
  const starting = useRef(false);

  const groups = KINDS.map((each) => ({
    kind: each,
    elements: story.elements.filter((element) => element.kind === each),
  }));
  const shown =
    kind === "all"
      ? story.elements
      : story.elements.filter((element) => element.kind === kind);
  // A telling may hold two hundred of these, and every card is a form: the
  // list is shown a shelf's worth at a time, as the asset shelf is.
  const visible = shown.slice(0, pages * SHELF_PAGE);

  /** Another kind of thing is another list, and it starts at its top. */
  const chooseKind = (next: StoryElementKind | "all") => {
    setKind(next);
    setPages(1);
  };
  /** Whether one of a card's own pictures is being made just now. */
  const drawing = (
    element: StoryElement,
    view: "main" | "turnaround",
  ): boolean =>
    targetRunning(
      jobs,
      story.id,
      targetKey({ kind: "element", elementId: element.id, view }),
    );
  const undrawn = story.elements.filter(
    (element) => currentTake(element.main) === undefined,
  );
  const viewsMissing = story.elements.filter(
    (element) =>
      element.kind === "character" &&
      currentTake(element.main) !== undefined &&
      currentTake(element.turnaround ?? EMPTY) === undefined,
  );
  // What a bulk button hands over: the places still missing that picture and
  // not already being drawn, since asking for a place twice pays for it twice.
  // It is also what the button counts, so its number is the work it would ask
  // for — while a card waits on its painter, the rest go on being askable.
  const drawable = undrawn.filter((element) => !drawing(element, "main"));
  const viewable = viewsMissing.filter(
    (element) => !drawing(element, "turnaround"),
  );
  const spoken = story.elements.some(elementDescribed);
  // The reading itself, rather than one of the drawings that follow it: a
  // chapter's worth of words takes a while, and the button that asked for it
  // is where a reader looks to see that it is still going.
  const reading = kindRunning(jobs, "elements");
  // What the newest reading had to say about what it could not read. Shown
  // rather than only logged, because a group of an answer that was not read is
  // a loss the document shows as simply not being there.
  const answerJob = jobs.find(
    (job) =>
      job.kind === "elements" &&
      job.items.some((item) => item.text !== undefined),
  );
  const warnings = (answerJob?.items ?? [])
    .filter((item) => item.text !== undefined)
    .flatMap((item) =>
      readElementsAnswer(item.text ?? "").warnings.map(
        (warning) => `${item.id}: ${warning}`,
      ),
    );

  // The parts of a long telling are read one after another, the next one
  // beginning when the one before it is over rather than when the reader
  // presses again — and not while a part is still being handed over, since two
  // readings out for one story are both written into the same cast and the last
  // one home is the only one left standing. A drawing batch is not a reading:
  // it is its own work on its own cards, and it does not hold the rest back.
  useEffect(() => {
    if (starting.current || sending || reading || waves.length === 0) return;
    const next = waves[0];
    if (next === undefined) return;
    const part = totalWaves - waves.length + 1;
    starting.current = true;
    void useStoryJobStore
      .getState()
      .start(
        story.id,
        "elements",
        planElements(story, {
          chapterIds: next,
          part,
          total: totalWaves,
        }),
      )
      .then((record) => {
        setWaves((held) => (record === null ? [] : held.slice(1)));
      })
      .finally(() => {
        starting.current = false;
      });
  }, [reading, waves, totalWaves, story, sending]);

  /** Reads the telling, whole or a part at a time. */
  const begin = async () => {
    setAsking(false);
    const cut = chapterWaves(story.chapters, storyReadChars()).map((wave) =>
      wave.map((chapter) => chapter.id),
    );
    setTotalWaves(Math.max(1, cut.length));
    setWaves(cut.slice(1));
    const first = cut[0] ?? [];
    const record = await useStoryJobStore
      .getState()
      .start(
        story.id,
        "elements",
        planElements(
          story,
          cut.length <= 1
            ? {}
            : { chapterIds: first, part: 1, total: cut.length },
        ),
      );
    // A first part that never went out leaves nothing for the rest to be read
    // beside, so the parts that were still to come are dropped with it.
    if (record === null) setWaves([]);
  };

  return (
    <div className="story-step-scroll" data-testid="story-step-elements-body">
      <div className="story-step-wide">
        <div className="story-step-bar">
          <p className="story-step-lead">{t("story:elements.lead")}</p>
          <StoryImportButton story={story} target="canvas" />
        </div>
        <StoryModelPicks places={["text", "image"]} />

        <div className="story-voice-narrator">
          <span className="story-hint" data-testid="story-voice-narrator-tip">
            {t("story:elements.narratorTip")}
          </span>
          <VoiceFields
            fallbackVoice={resolveVoice(story, undefined)}
            onWrite={(narrator) =>
              execute(i18n.t("story:history.elements"), [
                { type: "updateStoryNarrator", storyId: story.id, narrator },
              ])
            }
            story={story}
            testId="story-voice-narrator"
            voice={story.narrator}
          />
        </div>
        <VoiceSummary story={story} />

        {warnings.length > 0 && (
          <div
            className="story-warnings"
            data-testid="story-elements-warnings"
            role="status"
          >
            <ul>
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="story-step-bar">
          <div
            aria-label={t("story:elements.group")}
            className="story-chips"
            role="tablist"
          >
            <button
              aria-selected={kind === "all"}
              className={`story-choice${kind === "all" ? " is-on" : ""}`}
              data-testid="story-elements-group-all"
              onClick={() => chooseKind("all")}
              role="tab"
              type="button"
            >
              {t("story:elements.all", { count: story.elements.length })}
            </button>
            {groups.map((group) => (
              <button
                aria-selected={kind === group.kind}
                className={`story-choice${kind === group.kind ? " is-on" : ""}`}
                data-testid={`story-elements-group-${group.kind}`}
                key={group.kind}
                onClick={() => chooseKind(group.kind)}
                role="tab"
                type="button"
              >
                {t(`story:elements.group_${group.kind}`, {
                  count: group.elements.length,
                })}
              </button>
            ))}
          </div>
          <div className="story-step-actions">
            {drawable.length > 0 && (
              <button
                className="primary"
                data-testid="story-elements-draw-all"
                onClick={() =>
                  void run(
                    story.id,
                    "elementArt",
                    planElementArt(
                      story,
                      drawable.map((element) => ({
                        elementId: element.id,
                        view: "main" as const,
                      })),
                    ),
                  )
                }
                type="button"
              >
                {t("story:elements.drawAll", { count: drawable.length })}
              </button>
            )}
            {viewable.length > 0 && (
              <button
                data-testid="story-elements-views-all"
                onClick={() =>
                  void run(
                    story.id,
                    "elementArt",
                    planElementArt(
                      story,
                      viewable.map((element) => ({
                        elementId: element.id,
                        view: "turnaround" as const,
                      })),
                    ),
                  )
                }
                type="button"
              >
                {t("story:elements.viewsAll", { count: viewable.length })}
              </button>
            )}
            <button
              className="link"
              data-testid="story-elements-add"
              disabled={story.elements.length >= MAX_ELEMENTS_PER_STORY}
              onClick={() => setAdding(true)}
              type="button"
            >
              {t("story:elements.add")}
            </button>
            <button
              className="link"
              data-testid="story-elements-recognise"
              disabled={reading}
              onClick={() =>
                story.elements.length === 0 || !spoken
                  ? void begin()
                  : setAsking(true)
              }
              type="button"
            >
              {reading && <span className="story-spin" />}
              {reading
                ? t("story:elements.reading")
                : story.elements.length === 0
                  ? t("story:elements.recognise")
                  : t("story:elements.recogniseAgain")}
            </button>
            <StepConfirm step="elements" story={story} />
          </div>
        </div>

        <div className="story-step-actions">
          <span className="story-hint" data-testid="story-elements-counts">
            {t("story:elements.counts", {
              characters: groups[0]?.elements.length ?? 0,
              scenes: groups[1]?.elements.length ?? 0,
              props: groups[2]?.elements.length ?? 0,
            })}
          </span>
          {totalWaves > 1 && (running !== null || waves.length > 0) && (
            <span className="story-hint" data-testid="story-elements-wave">
              {t("story:outline.wave", {
                at: Math.max(1, totalWaves - waves.length),
                of: totalWaves,
              })}
            </span>
          )}
          {running !== null && (
            <span className="story-hint" data-testid="story-elements-running">
              {t("story:jobs.busy", jobProgress(running))}
            </span>
          )}
        </div>

        {failure !== null && (
          <p className="story-hint" data-testid="story-elements-error">
            {failure}
          </p>
        )}

        {story.elements.length === 0 ? (
          <div
            className="clip-empty clip-empty-first"
            data-testid="story-elements-empty"
          >
            <p>{t("story:elements.empty")}</p>
            <div className="story-step-actions">
              <button
                className="primary"
                data-testid="story-elements-empty-recognise"
                disabled={reading}
                onClick={() => void begin()}
                type="button"
              >
                {reading && <span className="story-spin" />}
                {reading
                  ? t("story:elements.reading")
                  : t("story:elements.recognise")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <ul className="story-elements">
              {visible.map((element) => (
                <ElementCard
                  busyMain={drawing(element, "main")}
                  busyTurnaround={drawing(element, "turnaround")}
                  element={element}
                  key={element.id}
                  story={story}
                />
              ))}
            </ul>
            {shown.length > visible.length && (
              <div className="story-paging">
                <span data-testid="story-elements-shown">
                  {t("story:elements.shown", {
                    shown: visible.length,
                    total: shown.length,
                  })}
                </span>
                <button
                  onClick={() => setPages((current) => current + 1)}
                  type="button"
                >
                  {t("story:elements.showMore", {
                    count: Math.min(SHELF_PAGE, shown.length - visible.length),
                  })}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {asking && (
        <ConfirmDialog
          body={t("story:elements.recogniseBody", {
            count: story.elements.length,
          })}
          confirm={t("story:elements.recogniseConfirm")}
          note={t("story:elements.recogniseNote")}
          onCancel={() => setAsking(false)}
          onConfirm={() => void begin()}
          testId="recognise-elements"
          title={t("story:elements.recogniseTitle")}
        />
      )}
      {adding && (
        <AddElementDialog
          onAdd={(draft) => {
            setAdding(false);
            addElement(story, draft);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}

/**
 * How much of the cast has a voice, and the way to the next one that has not.
 *
 * A telling may hold a hundred characters, so the count is the one glance
 * that says whether any of them still needs a voice, and the press is the
 * walk to the first of them rather than a scroll through the cards.
 */
function VoiceSummary({ story }: { story: StoryDocument }) {
  const { t } = useTranslation();
  const characters = story.elements.filter(
    (element) => element.kind === "character",
  );
  const named = characters.filter((element) =>
    voiceNamed(element.voice),
  ).length;
  const first = characters.find((element) => !voiceNamed(element.voice));

  return (
    <p className="story-voice-summary">
      <button
        className="link"
        data-testid="story-voice-summary"
        disabled={first === undefined}
        onClick={() => {
          if (first === undefined) return;
          const escaped = first.name.replace(/["\\]/g, "\\$&");
          document
            .querySelector(`[data-testid="story-voice-${escaped}"]`)
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}
        type="button"
      >
        {t("story:elements.voiceNamed", {
          named,
          total: characters.length,
        })}
      </button>
    </p>
  );
}

/** An element the reader typed in themselves. */
function addElement(
  story: StoryDocument,
  draft: { kind: StoryElementKind; name: string; description: string },
): void {
  const element: StoryElement = {
    id: nextElementId(story),
    kind: draft.kind,
    name: draft.name,
    description: draft.description,
    chapterIds: [],
    main: { takes: [] },
    ...(draft.kind === "character" ? { turnaround: { takes: [] } } : {}),
  };
  execute(i18n.t("story:history.elements"), [
    {
      type: "setStoryElements",
      storyId: story.id,
      elements: [...story.elements, element],
    },
  ]);
}

/** A name for an element nobody read out of the chapters, in the room's own list. */
function nextElementId(story: StoryDocument): string {
  for (let at = story.elements.length + 1; ; at += 1) {
    const id = `element-added-${at}`;
    if (!story.elements.some((held) => held.id === id)) return id;
  }
}

/** The form a reader adds an element with. */
function AddElementDialog({
  onAdd,
  onCancel,
}: {
  onAdd: (draft: {
    kind: StoryElementKind;
    name: string;
    description: string;
  }) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<StoryElementKind>("character");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const ready = name.trim() !== "" && description.trim() !== "";

  return (
    <div
      aria-label={t("story:elements.addTitle")}
      aria-modal="true"
      className="story-add-element"
      data-testid="add-element"
      role="dialog"
    >
      <h2>{t("story:elements.addTitle")}</h2>
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
          {t("story:elements.addConfirm")}
        </button>
      </div>
    </div>
  );
}
