import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_STORIES_PER_PROJECT,
  STORY_NAME_MAX,
  storyCurrentStep,
  storyProgress,
  type StoryDocument,
} from "../../../shared/domain";
import { execute } from "../../editor/commands/execute";
import { useProjectStore } from "../../editor/stores/projectStore";
import { i18n } from "../../../shared/i18n";
import { relativeTime } from "../relativeTime";
import { useStoryStore } from "../stores/storyStore";
import { RemoveStoryDialog } from "../components/RemoveStoryDialog";

/**
 * The stories this project tells, one row each.
 *
 * A row says three things in the width of a column: how far the telling has
 * got, what it is called, and where the work stands — which step is wanted
 * next, and how much of it is done. The rest of the row is the two things a
 * reader does to a story that is not the story itself: rename it, or take it
 * away.
 */
export function StorySide() {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const storyId = useStoryStore((state) => state.storyId);
  const [removing, setRemoving] = useState<StoryDocument | null>(null);
  const stories = moka?.stories ?? [];
  const full = stories.length >= MAX_STORIES_PER_PROJECT;

  return (
    <section className="story-side-content">
      <div className="story-side-head">
        <h2>{t("story:side.title")}</h2>
        <button
          aria-label={t("story:side.new")}
          className="story-new"
          data-testid="story-new"
          disabled={full}
          onClick={() => useStoryStore.getState().setNewStoryOpen(true)}
          title={
            full
              ? t("story:side.limit", { max: MAX_STORIES_PER_PROJECT })
              : undefined
          }
          type="button"
        >
          +
        </button>
      </div>
      <div className="story-side-scroll">
        {stories.length === 0 ? (
          <p className="inspector-empty" data-testid="story-side-empty">
            {t("story:side.empty")}
          </p>
        ) : (
          <ul className="story-list">
            {stories.map((story) => (
              <StoryRow
                key={story.id}
                active={story.id === storyId}
                story={story}
                onRemove={setRemoving}
              />
            ))}
          </ul>
        )}
      </div>
      {removing && (
        <RemoveStoryDialog
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            removeStory(removing.id);
            setRemoving(null);
          }}
          story={removing}
        />
      )}
    </section>
  );
}

/**
 * Takes a story out and leaves the room standing somewhere else in the list,
 * which is what a row that is no longer there asks for.
 */
function removeStory(storyId: string) {
  const stories = useProjectStore.getState().moka?.stories ?? [];
  const index = stories.findIndex((story) => story.id === storyId);
  const done = execute(i18n.t("story:history.delete"), [
    { type: "removeStory", storyId },
  ]);
  if (!done) return;
  if (useStoryStore.getState().storyId !== storyId) return;
  const rest = stories.filter((story) => story.id !== storyId);
  const next = rest[Math.min(index, rest.length - 1)] ?? rest[0] ?? null;
  useStoryStore.getState().select(next?.id ?? null);
}

/** One story, as the column reads it. */
function StoryRow({
  story,
  active,
  onRemove,
}: {
  story: StoryDocument;
  active: boolean;
  onRemove: (story: StoryDocument) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progress = storyProgress(story);
  const current = storyCurrentStep(progress);

  const commitRename = () => {
    if (draft === null) return;
    const name = draft.trim();
    if (name.length === 0 || name.length > STORY_NAME_MAX) {
      // The command has the last word, and a name it refuses leaves this input
      // standing rather than losing what was typed.
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
    setDraft(null);
    setError(null);
  };

  return (
    <li className={active ? "story-row is-active" : "story-row"}>
      <span
        className={`story-dot is-${current.state}`}
        title={t(`story:stepHint.${current.step}`)}
      />
      {draft === null ? (
        <button
          aria-pressed={active}
          className="story-main"
          onClick={() => useStoryStore.getState().select(story.id)}
          onDoubleClick={() => setDraft(story.name)}
          type="button"
        >
          <span className="story-row-name">{story.name}</span>
          <span className="story-row-meta">
            {t(`story:step.${current.step}`)}
            {current.total > 1 ? ` · ${current.done}/${current.total}` : ""}
          </span>
          <span className="story-row-when" title={story.updatedAt}>
            {relativeTime(
              story.updatedAt,
              new Date(),
              i18n.resolvedLanguage ?? "en",
            ) || t("story:list.neverEdited")}
          </span>
        </button>
      ) : (
        <>
          <input
            aria-invalid={error !== null}
            aria-label={t("story:side.rename", { name: story.name })}
            autoFocus
            className="story-rename"
            maxLength={STORY_NAME_MAX}
            onBlur={commitRename}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onFocus={(event) => event.target.select()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setDraft(null);
                setError(null);
              }
            }}
            value={draft}
          />
          {error !== null && (
            <span className="story-row-error" role="alert">
              {error}
            </span>
          )}
        </>
      )}
      <span className="story-row-actions">
        <button
          aria-label={t("story:side.rename", { name: story.name })}
          onClick={() => setDraft(story.name)}
          title={t("story:side.renameHint")}
          type="button"
        >
          ✎
        </button>
        <button
          aria-label={t("story:side.delete", { name: story.name })}
          data-testid={`story-delete-${story.name}`}
          onClick={() => onRemove(story)}
          title={t("story:side.deleteHint")}
          type="button"
        >
          ×
        </button>
      </span>
    </li>
  );
}
