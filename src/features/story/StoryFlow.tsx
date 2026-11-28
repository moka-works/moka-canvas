import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ASPECT_LABELS,
  STORY_NAME_MAX,
  formatDuration,
  type StoryDocument,
} from "../../shared/domain";
import { execute } from "../editor/commands/execute";
import { AgentDock } from "../assistant/agent/AgentDock";
import { StoryStepBody } from "./steps/StoryStepBody";
import {
  rememberStepScroll,
  stepScrollAt,
  useStoryStore,
} from "./stores/storyStore";

/**
 * One story's telling, from the premise to the finished film.
 *
 * The head says what the whole rests on — how long, in what frame, in what
 * words — and the stage under it is the step being stood on. Which step that is
 * and how far each has got are read in the room's left column, so the work the
 * step draws is given the whole width here. What the step itself looks like is
 * the step's own business, and each one is a component of its own so that a
 * board being edited does not re-render the outline beside it.
 */
export function StoryFlow({ story }: { story: StoryDocument }) {
  const { t } = useTranslation();
  const step = useStoryStore((state) => state.step);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The scroller is one element shared by every step, so a step is put back
  // where the reader left it rather than inheriting the last step's offset —
  // or, worse, having that offset clamped to the end of shorter work it has
  // just been given. Restored before the frame is drawn, so nothing flashes.
  const scrollKey = `${story.id}:${step}`;
  const bodyRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    body.scrollTop = stepScrollAt(scrollKey);
  }, [scrollKey]);
  useEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    const onScroll = () => rememberStepScroll(scrollKey, body.scrollTop);
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  }, [scrollKey]);

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
      <main
        aria-labelledby={`story-step-tab-${step}`}
        className="story-step-body"
        data-testid={`story-step-body-${step}`}
        id={`story-step-panel-${step}`}
        ref={bodyRef}
        role="tabpanel"
        tabIndex={-1}
      >
        {/* Keyed by the story: a step's own in-flight work — the parts it
            has not sent and the merge that follows them — belongs to the
            telling it was read from, and another telling opens a step of
            its own rather than inheriting the last one's. */}
        <StoryStepBody key={story.id} step={step} story={story} />
        <AgentDock compact room="story" />
      </main>
    </div>
  );
}
