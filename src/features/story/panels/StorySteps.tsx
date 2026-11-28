import type { KeyboardEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  STORY_STEPS,
  stepReachable,
  storyProgress,
  type StoryDocument,
  type StoryStep,
  type StoryStepProgress,
} from "../../../shared/domain";
import {
  StepFailurePanel,
  type FailureAnchor,
} from "../components/StepFailurePanel";
import { useStoryStepFailure } from "../stores/storyJobStore";
import { useStoryStore } from "../stores/storyStore";

/**
 * The five steps of a telling, read down the left column.
 *
 * A step is a drawer of one column rather than a rail across the top of the
 * stage: what is standing is marked, what has been earned is walked to, and
 * what has not says which step comes first. The stage beside it is left whole
 * for the work itself, which is what a telling needs the room for.
 *
 * The failures behind a step's red count belong to this column too, since the
 * badge that opens them does.
 */
export function StorySteps({ story }: { story: StoryDocument | null }) {
  const { t } = useTranslation();
  const step = useStoryStore((state) => state.step);
  const [failures, setFailures] = useState<{
    step: StoryStep;
    anchor: FailureAnchor;
  } | null>(null);

  if (story === null) {
    return (
      <section className="story-steps-face">
        <div className="story-side-head">
          <h2>{t("story:steps.title")}</h2>
        </div>
        <p className="inspector-empty" data-testid="story-steps-empty">
          {t("story:steps.none")}
        </p>
      </section>
    );
  }

  const progress = storyProgress(story);
  const onStepKeys = (event: KeyboardEvent<HTMLElement>) => {
    const at = STORY_STEPS.indexOf(step);
    const movable = STORY_STEPS.filter(
      (each) => stepReachable(progress, each) || each === "idea",
    );
    const go = (next: StoryStep) => {
      event.preventDefault();
      useStoryStore.getState().goStep(next);
      const button = document.querySelector<HTMLButtonElement>(
        `[data-testid="story-step-${next}"]`,
      );
      button?.focus();
    };
    if (event.key === "ArrowDown") {
      const next = movable.find((each) => STORY_STEPS.indexOf(each) > at);
      if (next) go(next);
    } else if (event.key === "ArrowUp") {
      const before = [...movable]
        .reverse()
        .find((each) => STORY_STEPS.indexOf(each) < at);
      if (before) go(before);
    } else if (event.key === "Home") {
      go("idea");
    } else if (event.key === "End") {
      const last = movable[movable.length - 1];
      if (last) go(last);
    }
  };

  /**
   * The panel a badge opens, and the badge it belongs to.
   *
   * A badge is the panel's own door: pressing the one already open puts the
   * panel away rather than opening the same reading again.
   */
  const showFailures = (at: StoryStep, anchor: FailureAnchor) => {
    setFailures((held) => (held?.step === at ? null : { step: at, anchor }));
  };
  const closeFailures = () => {
    const at = failures?.step;
    setFailures(null);
    if (at === undefined) return;
    document
      .querySelector<HTMLButtonElement>(
        `[data-testid="story-step-failed-${at}"]`,
      )
      ?.focus();
  };

  return (
    <section className="story-steps-face">
      <div className="story-side-head">
        <h2>{t("story:steps.title")}</h2>
      </div>
      <nav
        aria-label={t("story:steps.label")}
        className="story-steps"
        onKeyDown={onStepKeys}
        role="tablist"
      >
        {STORY_STEPS.map((each, index) => (
          <StepButton
            current={each === step}
            failuresOpen={failures?.step === each}
            index={index}
            key={each}
            onShowFailures={(anchor) => showFailures(each, anchor)}
            progress={progress}
            step={each}
            storyId={story.id}
          />
        ))}
      </nav>
      {failures !== null && (
        <StepFailurePanel
          anchor={failures.anchor}
          onClose={closeFailures}
          step={failures.step}
          story={story}
        />
      )}
    </section>
  );
}

function StepButton({
  step,
  index,
  current,
  failuresOpen,
  onShowFailures,
  progress,
  storyId,
}: {
  step: StoryStep;
  index: number;
  current: boolean;
  failuresOpen: boolean;
  onShowFailures: (anchor: FailureAnchor) => void;
  progress: Record<StoryStep, StoryStepProgress>;
  storyId: string;
}) {
  const { t } = useTranslation();
  const held = progress[step];
  const reachable = stepReachable(progress, step);
  const previous = STORY_STEPS[Math.max(0, index - 1)];
  // What a step is waiting on is not in the document, so the count of pieces
  // that did not come back is laid over the step rather than read off it.
  const failure = useStoryStepFailure(storyId, step);
  return (
    <div className="story-step-row" role="presentation">
      <button
        aria-controls={`story-step-panel-${step}`}
        aria-selected={current}
        className={`story-step is-${held.state}${current ? " is-active" : ""}${
          failure === null ? "" : " is-failed"
        }`}
        data-testid={`story-step-${step}`}
        disabled={!reachable}
        id={`story-step-tab-${step}`}
        onClick={() => useStoryStore.getState().goStep(step)}
        role="tab"
        title={
          !reachable
            ? t("story:steps.locked", { step: t(`story:step.${previous}`) })
            : failure === null
              ? t(`story:stepHint.${step}`)
              : failure.reasons.length === 0
                ? t("story:jobs.stepFailed", { failed: failure.failed })
                : t("story:jobs.stepFailedWith", {
                    failed: failure.failed,
                    reason: failure.reasons[0],
                  })
        }
        type="button"
      >
        <span className="story-step-index">{index + 1}</span>
        <span className="story-step-name">{t(`story:step.${step}`)}</span>
        <span className="story-step-count">
          {held.total > 0 ? `${held.done}/${held.total}` : ""}
        </span>
      </button>
      {failure !== null && (
        // The badge is its own control rather than part of the step's tab: a
        // step that cannot be walked to still has a batch that came home short,
        // and what that batch says is not reached by pressing a disabled tab.
        <button
          aria-expanded={failuresOpen}
          aria-haspopup="dialog"
          aria-label={t("story:jobs.viewFailures", {
            step: t(`story:step.${step}`),
            count: failure.failed,
          })}
          className="story-step-failed"
          data-testid={`story-step-failed-${step}`}
          onClick={(event) =>
            onShowFailures(event.currentTarget.getBoundingClientRect())
          }
          title={t("story:jobs.viewFailures", {
            step: t(`story:step.${step}`),
            count: failure.failed,
          })}
          type="button"
        >
          {failure.failed}
        </button>
      )}
    </div>
  );
}
