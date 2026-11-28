import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  TIMELINE_NAME_MAX,
  type TimelineDocument,
  type TimelineId,
} from "../../../shared/domain";
import { execute } from "../../editor/commands/execute";
import { useProjectStore } from "../../editor/stores/projectStore";
import { PlusIcon, TimelineIcon } from "../components/ClipIcons";
import { switchTimeline } from "../interactions/timelineSwitch";
import { useClipStore } from "../stores/clipStore";
import { RemoveTimelineDialog } from "./RemoveTimelineDialog";

/** The cut being renamed, and the words it is being renamed with. */
interface Rename {
  id: TimelineId;
  draft: string;
  /** What is wrong with the draft; null while it reads as a name. */
  error: string | null;
}

/**
 * Every cut the project holds, as the rail's selector reads them.
 *
 * The strip across the bar holds the open cuts; this face is the whole list
 * read down the column, and therefore where a cut is named and taken away —
 * a closed tab is still a row here, so managing a cut never depends on its tab
 * being up. Pressing a row opens that cut (and puts its tab up), a double-click
 * or the pencil renames it in place, and the × deletes it. A project with no
 * cut yet is offered the one thing there is to do.
 */
export function TimelinePicker() {
  const { t } = useTranslation();
  const timelines = useProjectStore((state) => state.moka?.timelines) ?? [];
  const activeId = useClipStore((state) => state.activeTimelineId);
  const [renaming, setRenaming] = useState<Rename | null>(null);
  const [removing, setRemoving] = useState<TimelineId | null>(null);

  const commitRename = (draft: Rename) => {
    const timeline = timelines.find((each) => each.id === draft.id);
    const name = draft.draft.trim();
    if (!timeline || name === timeline.name) {
      setRenaming(null);
      return;
    }
    // Checked here as well as in the command so the reader is told beside the
    // row rather than by a toast across the room; the command still has the
    // last word, and a name it refuses keeps this input standing.
    if (name.length === 0 || name.length > TIMELINE_NAME_MAX) {
      setRenaming({
        ...draft,
        error:
          name.length === 0
            ? t("clip:timelinePicker.needsName")
            : t("clip:timelinePicker.nameTooLong", { max: TIMELINE_NAME_MAX }),
      });
      return;
    }
    const done = execute(t("clip:history.renameTimeline"), [
      { type: "renameTimeline", timelineId: timeline.id, name },
    ]);
    if (done) setRenaming(null);
  };

  const removeTimeline = (timelineId: TimelineId) => {
    const index = timelines.findIndex((each) => each.id === timelineId);
    const done = execute(t("clip:history.removeTimeline"), [
      { type: "removeTimeline", timelineId },
    ]);
    if (!done) return;
    if (timelineId === activeId) {
      // The room moves to the cut beside the one that left, as a strip of tabs
      // does anywhere else in the app. No history boundary on the way: a seam
      // pushed here would stand between the deletion and its own undo.
      const rest = timelines.filter((each) => each.id !== timelineId);
      const next = rest[Math.min(index, rest.length - 1)] ?? rest[0] ?? null;
      useClipStore.getState().setActiveTimeline(next?.id ?? null);
    }
  };

  const askToRemove = (timeline: TimelineDocument) => {
    // A timeline with clips on it asks first — the whole of it leaves, and undo
    // is a thing a reader should not have to be told about afterwards. An
    // empty one is just a row, and a row is taken away in one click.
    if (timeline.clips.length > 0) {
      setRemoving(timeline.id);
      return;
    }
    removeTimeline(timeline.id);
  };

  const asked = timelines.find((each) => each.id === removing) ?? null;

  return (
    <div className="clip-timeline-picker">
      {timelines.length === 0 ? (
        <p className="inspector-empty" data-testid="timeline-picker-empty">
          {t("clip:timelinePicker.empty")}
        </p>
      ) : (
        <ul
          aria-label={t("clip:timelinePicker.list")}
          className="clip-timeline-list"
        >
          {timelines.map((timeline) => {
            const active = timeline.id === activeId;
            const editing = renaming?.id === timeline.id ? renaming : null;
            const count = timeline.clips.length;
            return (
              <li
                className={
                  active ? "clip-timeline-row is-active" : "clip-timeline-row"
                }
                key={timeline.id}
              >
                {editing ? (
                  <>
                    <input
                      aria-invalid={editing.error !== null}
                      aria-label={t("clip:timelinePicker.rename", {
                        name: timeline.name,
                      })}
                      autoFocus
                      className="clip-timeline-rename"
                      maxLength={TIMELINE_NAME_MAX}
                      onBlur={() => commitRename(editing)}
                      onChange={(event) =>
                        setRenaming({
                          ...editing,
                          draft: event.target.value,
                          error: null,
                        })
                      }
                      onFocus={(event) => event.target.select()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitRename(editing);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setRenaming(null);
                        }
                      }}
                      value={editing.draft}
                    />
                    {editing.error !== null && (
                      <span className="clip-timeline-error" role="alert">
                        {editing.error}
                      </span>
                    )}
                  </>
                ) : (
                  <button
                    aria-current={active ? "true" : undefined}
                    className="clip-timeline-main"
                    data-testid={`timeline-picker-${timeline.name}`}
                    onClick={() => switchTimeline(timeline)}
                    onDoubleClick={() =>
                      setRenaming({
                        id: timeline.id,
                        draft: timeline.name,
                        error: null,
                      })
                    }
                    title={t("clip:timelinePicker.openHint", {
                      name: timeline.name,
                    })}
                    type="button"
                  >
                    <TimelineIcon size={15} />
                    <span className="clip-timeline-name">{timeline.name}</span>
                    <span className="clip-timeline-count">
                      {count}{" "}
                      {t(
                        count === 1
                          ? "clip:common.clipOne"
                          : "clip:common.clipMany",
                      )}
                    </span>
                  </button>
                )}
                <span className="clip-timeline-actions">
                  <button
                    aria-label={t("clip:timelinePicker.rename", {
                      name: timeline.name,
                    })}
                    onClick={() =>
                      setRenaming({
                        id: timeline.id,
                        draft: timeline.name,
                        error: null,
                      })
                    }
                    title={t("clip:timelinePicker.renameHint")}
                    type="button"
                  >
                    ✎
                  </button>
                  <button
                    aria-label={t("clip:timelinePicker.delete", {
                      name: timeline.name,
                    })}
                    className="clip-timeline-delete"
                    data-testid={`timeline-picker-delete-${timeline.name}`}
                    onClick={() => askToRemove(timeline)}
                    title={t("clip:timelinePicker.deleteHint")}
                    type="button"
                  >
                    ×
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <button
        className="clip-timeline-new"
        data-testid="timeline-picker-new"
        onClick={() => useClipStore.getState().setNewTimelineOpen(true)}
        type="button"
      >
        <PlusIcon size={15} />
        {t("clip:timelinePicker.new")}
      </button>
      {asked &&
        // The question covers the whole window, so it is asked from the
        // window's own box rather than from the column it stands in.
        createPortal(
          <RemoveTimelineDialog
            onCancel={() => setRemoving(null)}
            onConfirm={() => {
              setRemoving(null);
              removeTimeline(asked.id);
            }}
            timeline={asked}
          />,
          document.body,
        )}
    </div>
  );
}
