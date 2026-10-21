import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ASPECT_LABELS,
  STORY_NAME_MAX,
  STORY_STEPS,
  formatDuration,
  stepReachable,
  storyProgress,
  type StoryDocument,
  type StoryStep,
  type StoryStepProgress,
} from "../../shared/domain";
import { execute } from "../editor/commands/execute";
import { AgentDock } from "../assistant/agent/AgentDock";
import { StoryStepBody } from "./steps/StoryStepBody";
import { useStoryStepFailure } from "./stores/storyJobStore";
import { useStoryStore } from "./stores/storyStore";

/**
 * One story's telling, from the premise to the finished film.
 *
 * The head says what the whole rests on — how long, in what frame, in what
 * words — and the column beside it is the five steps: which is being stood on,
 * which are still to come, and how far each has got. What the step itself
 * looks like is the step's own business, and each one is a component of its
 * own so that a board being edited does not re-render the outline beside it.
 */
export function StoryFlow({ story }: { story: StoryDocument }) {
  const { t } = useTranslation();
  const step = useStoryStore((state) => state.step);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progress = storyProgress(story);

  const commitRename = () => {
    if (renaming === null) return;
    const name = renaming.trim();
    if (name.length === 0 || name.length > STORY_NAME_MAX) {
      setError(
        name.length === 0
          ? t("story:side.needsName")
          : t("story:side.nameTooLong", { max: STORY_NAME_MAX }),
      );
      return;
    }
    if (name !== story.name) {
      const done = execute(t("story:history.rename"), [
        { type: "renameStory", storyId: story.id, name },
      ]);
      if (!done) return;
    }
    setRenaming(null);
    setError(null);
  };

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

  return (
    <div className="story-flow">
      <header className="story-head">
        {renaming === null ? (
          <h2
            className="story-head-name"
            onDoubleClick={() => setRenaming(story.name)}
            title={t("story:side.renameHint")}
          >
            {story.name}
          </h2>
        ) : (
          <input
            aria-invalid={error !== null}
            aria-label={t("story:side.rename", { name: story.name })}
            autoFocus
            className="story-rename"
            maxLength={STORY_NAME_MAX}
            onBlur={commitRename}
            onChange={(event) => {
              setRenaming(event.target.value);
              setError(null);
            }}
            onFocus={(event) => event.target.select()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setRenaming(null);
                setError(null);
              }
            }}
            value={renaming}
          />
        )}
        <button
          className="story-head-edit"
          onClick={() => useStoryStore.getState().goStep("idea")}
          type="button"
        >
          {t("story:head.editBrief")}
        </button>
        <span className="story-head-chips">
          <span className="story-chip">
            {formatDuration(story.brief.totalDurationMs)}
          </span>
          <span className="story-chip">
            {t(ASPECT_LABELS[story.brief.aspect])}
          </span>
          <span
            className={
              story.brief.genre ? "story-chip" : "story-chip is-missing"
            }
            onClick={() => useStoryStore.getState().goStep("idea")}
          >
            {story.brief.genre || t("story:head.genreUnset")}
          </span>
          <span
            className={
              story.brief.style ? "story-chip" : "story-chip is-missing"
            }
            onClick={() => useStoryStore.getState().goStep("idea")}
          >
            {story.brief.style || t("story:head.styleUnset")}
          </span>
        </span>
      </header>
      <div className="story-flow-body">
        <nav
          aria-label={t("story:steps.label")}
          className="story-steps"
          onKeyDown={onStepKeys}
          role="tablist"
        >
          {STORY_STEPS.map((each, index) => (
            <StepButton
              current={each === step}
              index={index}
              key={each}
              progress={progress}
              step={each}
              storyId={story.id}
            />
          ))}
        </nav>
        <main
          aria-labelledby={`story-step-tab-${step}`}
          className="story-step-body"
          data-testid={`story-step-body-${step}`}
          id={`story-step-panel-${step}`}
          role="tabpanel"
          tabIndex={-1}
        >
          <StoryStepBody step={step} story={story} />
          <AgentDock compact room="story" />
        </main>
      </div>
    </div>
  );
}

function StepButton({
  step,
  index,
  current,
  progress,
  storyId,
}: {
  step: StoryStep;
  index: number;
  current: boolean;
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
      {failure !== null && (
        <span
          className="story-step-failed"
          data-testid={`story-step-failed-${step}`}
        >
          {failure.failed}
        </span>
      )}
    </button>
  );
}
