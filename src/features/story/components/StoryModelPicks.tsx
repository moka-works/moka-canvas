import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Capability } from "../../../shared/domain";
import {
  modelNameOf,
  modelOptionsFor,
  useModelStore,
} from "../../settings/modelStore";
import {
  audioReferenceLabel,
  modelAudioReference,
} from "../../settings/modelAudioReference";
import {
  STORY_ASK_PLACES,
  useStoryModels,
  type StoryAskPlace,
} from "../stores/storyModels";
import {
  STORY_PARALLEL_MIN,
  storyMaxParallel,
  useStoryBatch,
} from "../stores/storyBatch";

/**
 * Which capability a place is asked of.
 *
 * A telling asks two kinds of sound: its lines are read aloud by a speech
 * model, and the music under its acts is composed by a music model. The
 * pickers are named after what the room makes there, so the voice place
 * speaks in the capability's own terms rather than the file's.
 */
const CAPABILITY_OF_PLACE: Record<StoryAskPlace, Capability> = {
  text: "text",
  image: "image",
  video: "video",
  audio: "speech",
  music: "music",
};

/**
 * The models the buttons below will ask.
 *
 * One picker per kind of work the step does, standing on the band under the
 * words that say what the step is for and beside the numbers the step asks
 * with: which models answer is settled before the ask rather than discovered
 * after it. A picker takes several models, and the room asks them in the order
 * they were picked — each new batch takes the next turn, so a telling's work
 * is spread over the models a reader trusts rather than piled on one. Nothing
 * picked is the deployment's default, and the pickers are kept per place — a
 * telling's score is not its voice, even when one model does both.
 */
export function StoryModelPicks({
  places,
  withParallel = false,
}: {
  places: StoryAskPlace[];
  /** Whether the band also offers the count the step's batches run at. */
  withParallel?: boolean;
}) {
  const { t } = useTranslation();
  const choices = useStoryModels((state) => state.choices);

  return (
    <div
      aria-label={t("story:models.label")}
      className="story-models"
      data-testid="story-models"
      role="group"
    >
      <span className="story-hint">{t("story:models.label")}</span>
      {STORY_ASK_PLACES.filter((place) => places.includes(place)).map(
        (place) => (
          <ModelPoolPicker
            capability={CAPABILITY_OF_PLACE[place]}
            key={place}
            label={t(`story:models.${place}`)}
            noneLabel={
              place === "music"
                ? t("story:models.musicDefault")
                : t("story:models.default")
            }
            onChange={(references) =>
              useStoryModels.getState().choose(place, references)
            }
            place={place}
            value={choices[place] ?? []}
          />
        ),
      )}
      {withParallel && <ParallelPick />}
    </div>
  );
}

/**
 * The models one place is asked of, picked in the order their turns take.
 *
 * A place keeps its own list, so the menu is a set of checkmarks rather than a
 * single value: ticking a model adds it to the end of the turn, unticking it
 * takes it out, and leaving every row alone hands the place back to the
 * deployment's default. The list is read on the button as the models' names
 * rather than as a count, so what a batch will be asked of is legible before
 * the ask.
 */
function ModelPoolPicker({
  capability,
  label,
  noneLabel,
  place,
  value,
  onChange,
}: {
  capability: Capability;
  label: string;
  /** What choosing nothing is called: the deployment's own model. */
  noneLabel: string;
  place: StoryAskPlace;
  /** The models this place asks, in rotation order. */
  value: string[];
  onChange: (references: string[]) => void;
}) {
  const { t } = useTranslation();
  const view = useModelStore((state) => state.view);
  const protocols = useModelStore((state) => state.protocols);
  const menu = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const options = useMemo(
    () => modelOptionsFor(view, capability),
    [view, capability],
  );
  // A stored model that has since been switched off or deleted stays listed,
  // so the list can still be seen and cleared rather than quietly shrinking.
  const orphans = value.filter(
    (reference) => !options.some((option) => option.reference === reference),
  );
  const nameOf = (reference: string): string => {
    const option = options.find((held) => held.reference === reference);
    return option?.label ?? modelNameOf(view, reference);
  };
  const names = value.map(nameOf);
  const summary = names.length === 0 ? noneLabel : names.join(" / ");

  const close = () => {
    if (menu.current !== null) menu.current.open = false;
    setOpen(false);
  };
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const element = menu.current;
      if (element === null) return;
      if (event.target instanceof Node && element.contains(event.target))
        return;
      close();
    };
    const back = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      menu.current?.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", back);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", back);
    };
  }, [open]);

  const toggle = (reference: string) => {
    onChange(
      value.includes(reference)
        ? value.filter((held) => held !== reference)
        : [...value, reference],
    );
  };

  return (
    <details
      className="story-model story-model-pool"
      data-testid={`story-model-${place}`}
      ref={menu}
    >
      <summary
        aria-label={t("story:models.choose", { label })}
        className="story-model-pool-toggle"
        data-testid={`story-model-${place}-toggle`}
        onClick={(event) => {
          event.preventDefault();
          setOpen(!open);
          if (menu.current !== null) menu.current.open = !open;
        }}
        title={summary}
      >
        <span className="story-model-pool-label">{label}</span>
        <span className="story-model-pool-value">{summary}</span>
        {value.length > 1 && (
          <span
            className="story-model-pool-count"
            data-testid={`story-model-${place}-count`}
          >
            {t("story:models.poolCount", { count: value.length })}
          </span>
        )}
      </summary>
      {open && (
        <div className="story-model-pool-menu">
          <button
            className={`story-model-pool-row${value.length === 0 ? " is-on" : ""}`}
            data-testid={`story-model-${place}-default`}
            onClick={() => onChange([])}
            type="button"
          >
            {noneLabel}
          </button>
          {options.map((option) => {
            const at = value.indexOf(option.reference);
            const model = view?.models.find(
              (held) => held.id === option.reference,
            );
            const ability = audioReferenceLabel(
              t,
              modelAudioReference(model, protocols),
            );
            return (
              <label
                className={`story-model-pool-row${at >= 0 ? " is-on" : ""}`}
                key={option.reference}
              >
                <input
                  checked={at >= 0}
                  data-testid={`story-model-${place}-option-${option.reference}`}
                  onChange={() => toggle(option.reference)}
                  type="checkbox"
                />
                <span>{option.label}</span>
                {ability !== null && (
                  <span className="story-hint">{ability}</span>
                )}
                {value.length > 1 && at >= 0 && (
                  <span className="story-model-pool-turn">
                    {t("story:models.turn", { at: at + 1 })}
                  </span>
                )}
              </label>
            );
          })}
          {orphans.map((reference) => (
            <label className="story-model-pool-row is-on" key={reference}>
              <input
                checked
                data-testid={`story-model-${place}-option-${reference}`}
                onChange={() => toggle(reference)}
                type="checkbox"
              />
              <span>
                {t("settings:picker.unavailable", { value: reference })}
              </span>
            </label>
          ))}
          <span className="story-hint">{t("story:models.poolHint")}</span>
        </div>
      )}
    </details>
  );
}

/**
 * How many generations the step's batches ask one model to run at once.
 *
 * The count is per model rather than per batch: two batches asking the same
 * model wait in the same queue, while a different model keeps a queue of its
 * own. The deployment's ceiling is the most this picker offers.
 */
function ParallelPick() {
  const { t } = useTranslation();
  const parallel = useStoryBatch((state) => state.parallel);
  const choose = useStoryBatch((state) => state.choose);
  const most = storyMaxParallel();
  const value = Math.min(parallel, most);
  const counts = Array.from(
    { length: most - STORY_PARALLEL_MIN + 1 },
    (_, at) => STORY_PARALLEL_MIN + at,
  );

  return (
    <div
      className="story-model"
      data-testid="story-model-parallel"
      title={t("story:models.parallelTip", { max: most })}
    >
      <label className="dialog-field">
        <span>{t("story:models.parallel")}</span>
        <select
          data-testid="story-parallel"
          onChange={(event) => choose(Number(event.target.value))}
          value={value}
        >
          {counts.map((count) => (
            <option key={count} value={count}>
              {count}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
