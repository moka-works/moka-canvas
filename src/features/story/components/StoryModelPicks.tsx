import { useTranslation } from "react-i18next";
import type { Capability } from "../../../shared/domain";
import { ModelPicker } from "../../settings/ModelPicker";
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
 * with: which model answers is settled before the ask rather than discovered
 * after it. Nothing picked is the deployment's default, and the pickers are
 * kept per place — a telling's score is not its voice, even when one model
 * does both.
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
          <div
            className="story-model"
            data-testid={`story-model-${place}`}
            key={place}
          >
            <ModelPicker
              capability={CAPABILITY_OF_PLACE[place]}
              label={t(`story:models.${place}`)}
              noneLabel={
                place === "music"
                  ? t("story:models.musicDefault")
                  : t("story:models.default")
              }
              onChange={(reference) =>
                useStoryModels.getState().choose(place, reference)
              }
              value={choices[place] ?? null}
            />
          </div>
        ),
      )}
      {withParallel && <ParallelPick />}
    </div>
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
