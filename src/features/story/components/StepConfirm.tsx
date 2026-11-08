import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  STORY_STEPS,
  STORY_IDEA_MIN,
  stepGaps,
  storyProgress,
  type StoryDocument,
  type StoryStep,
  type StoryStepGap,
} from "../../../shared/domain";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useStoryStore } from "../stores/storyStore";

/**
 * The one thing every step has instead of a confirmation per piece: a press
 * that reads the step whole.
 *
 * It stands at the far end of the row the step's own buttons are in, set apart
 * from them, since it settles the step rather than asking for one of the
 * things the step is worked with. Pressing it settles the step — what opens
 * the step after it, and the only thing that does — and takes the reader
 * there. A step that is not finished yet says what is missing rather than
 * refusing in silence, so the press is also how a reader finds out what is
 * left to do at this stage.
 *
 * The check is the domain's own reading of the document, and the interface
 * only words it: what a gap is called in the reader's language belongs here,
 * and whether there is a gap at all does not.
 */
export function StepConfirm({
  story,
  step,
  prepare,
}: {
  story: StoryDocument;
  step: StoryStep;
  /**
   * Words a step holds as a draft rather than in the document, written down
   * before the press reads it: a check that ran on a step behind the reader's
   * own typing would say the opposite of what is written on the screen.
   */
  prepare?: () => void;
}) {
  const { t } = useTranslation();
  const [gaps, setGaps] = useState<StoryStepGap[]>([]);
  const at = STORY_STEPS.indexOf(step);
  const next: StoryStep | undefined = STORY_STEPS[at + 1];
  const settled = storyProgress(story)[step].state === "confirmed";
  const last = next === undefined;

  // What was missing a moment ago is not what is missing now: a reason list
  // stands only until the document it was read from is written to again.
  useEffect(() => {
    setGaps([]);
  }, [story]);

  const press = () => {
    prepare?.();
    // Read off the document as it stands rather than off the one this render
    // was drawn from: a draft written down a line ago is part of the reading.
    const held =
      (useProjectStore.getState().moka?.stories ?? []).find(
        (each) => each.id === story.id,
      ) ?? story;
    const missing = stepGaps(held, step);
    if (missing.length > 0) {
      setGaps(missing);
      return;
    }
    setGaps([]);
    if (!held.confirmedSteps.includes(step)) {
      execute(i18n.t("story:history.confirm"), [
        { type: "confirmStoryStep", storyId: story.id, step, confirmed: true },
      ]);
    }
    if (next !== undefined) useStoryStore.getState().goStep(next);
  };

  return (
    <>
      <button
        className="story-confirm-button"
        data-testid={`story-confirm-${step}`}
        disabled={settled && last}
        onClick={press}
        type="button"
      >
        {t("story:confirm.button")}
      </button>
      {gaps.length > 0 && (
        <div
          className="story-warnings story-confirm-gaps"
          data-testid={`story-confirm-gaps-${step}`}
          role="alert"
        >
          <ul>
            {gaps.map((gap, index) => (
              <li key={index}>{gapLine(gap, t)}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** One gap, in the reader's language. */
function gapLine(
  gap: StoryStepGap,
  t: (key: string, values?: Record<string, unknown>) => string,
): string {
  switch (gap.kind) {
    case "ideaMissing":
      return t("story:confirm.gapIdea", { min: STORY_IDEA_MIN });
    case "noChapters":
      return t("story:confirm.gapNoChapters");
    case "chaptersUnwritten":
      return t("story:confirm.gapChapters", {
        count: gap.numbers.length,
        list: gap.numbers.map(String),
      });
    case "noElements":
      return t("story:confirm.gapNoElements");
    case "elementsUndescribed":
      return t("story:confirm.gapUndescribed", {
        count: gap.names.length,
        list: gap.names,
      });
    case "elementsUndrawn":
      return t("story:confirm.gapUndrawn", {
        count: gap.names.length,
        list: gap.names,
      });
    case "noActs":
      return t("story:confirm.gapNoActs");
    case "actsWithoutShots":
      return t("story:confirm.gapNoShots", { count: gap.count });
    case "framesMissing":
      return t("story:confirm.gapFrames", { count: gap.count });
    case "clipsMissing":
      return t("story:confirm.gapActClips", { count: gap.count });
    case "shotsMissing":
      return t("story:confirm.gapShotClips", { count: gap.count });
    case "noTimeline":
      return t("story:confirm.gapNoTimeline");
  }
}
