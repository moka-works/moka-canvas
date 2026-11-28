import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  TIMELINE_NAME_MAX,
  type TimelineDocument,
  type TimelineId,
} from "../../../shared/domain";
import { execute } from "../../editor/commands/execute";
import { useProjectStore } from "../../editor/stores/projectStore";
import { switchTimeline } from "../interactions/timelineSwitch";
import { useClipStore } from "../stores/clipStore";

/** The tab being renamed, and the words it is being renamed with. */
interface Rename {
  id: TimelineId;
  draft: string;
  /** What is wrong with the draft; null while it reads as a name. */
  error: string | null;
}

/**
 * The strip of every timeline the project holds.
 *
 * All of them, in the order the document keeps them, rather than the open
 * ones a board strip shows: a project holds a handful of cuts and they are all
 * worth a tab, so the strip is the list itself and there is no second memory
 * of what is open to keep. A tab is turned over by a click, renamed by a
 * double-click, and taken away by the small × beside it.
 */
export function TimelineTabs() {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const activeTimelineId = useClipStore((state) => state.activeTimelineId);
  const setActiveTimeline = useClipStore((state) => state.setActiveTimeline);
  const setNewTimelineOpen = useClipStore((state) => state.setNewTimelineOpen);
  const [renaming, setRenaming] = useState<Rename | null>(null);
  const [removing, setRemoving] = useState<TimelineId | null>(null);
  const timelines = moka?.timelines ?? [];

  const switchTo = switchTimeline;

  const commitRename = () => {
    if (!renaming) return;
    const timeline = timelines.find((each) => each.id === renaming.id);
    const name = renaming.draft.trim();
    if (!timeline || name === timeline.name) {
      setRenaming(null);
      return;
    }
    // Checked here as well as in the command so the reader is told beside the
    // field rather than by a toast across the room; the command still has the
    // last word, and a name it refuses keeps this input standing.
    if (name.length === 0 || name.length > TIMELINE_NAME_MAX) {
      setRenaming({
        ...renaming,
        error:
          name.length === 0
            ? t("clip:tabs.needsName")
            : t("clip:tabs.nameTooLong", { max: TIMELINE_NAME_MAX }),
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
    if (timelineId === activeTimelineId) {
      // The room moves to the tab beside the one that left, as a strip of tabs
      // does anywhere else in the app. No history boundary on the way: a seam
      // pushed here would stand between the deletion and its own undo.
      const rest = timelines.filter((each) => each.id !== timelineId);
      const next = rest[Math.min(index, rest.length - 1)] ?? rest[0] ?? null;
      setActiveTimeline(next?.id ?? null);
    }
  };

  const askToRemove = (timeline: TimelineDocument) => {
    // A timeline with clips on it asks first — the whole of it leaves, and undo
    // is a thing a reader should not have to be told about afterwards. An
    // empty one is just a tab, and a tab is taken away in one click.
    if (timeline.clips.length > 0) {
      setRemoving(timeline.id);
      return;
    }
    removeTimeline(timeline.id);
  };

  const asked = timelines.find((each) => each.id === removing) ?? null;

  return (
    <>
      <div
        aria-label={t("clip:tabs.list")}
        className="timeline-tabs"
        role="tablist"
      >
        {timelines.map((timeline) => {
          const active = timeline.id === activeTimelineId;
          const editing = renaming?.id === timeline.id ? renaming : null;
          return (
            <span
              className={active ? "timeline-tab is-active" : "timeline-tab"}
              key={timeline.id}
            >
              {editing ? (
                <>
                  <input
                    aria-invalid={editing.error !== null}
                    aria-label={t("clip:tabs.rename", { name: timeline.name })}
                    autoFocus
                    maxLength={TIMELINE_NAME_MAX}
                    onBlur={commitRename}
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
                        commitRename();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setRenaming(null);
                      }
                    }}
                    value={editing.draft}
                  />
                  {editing.error !== null && (
                    <span className="timeline-tab-error" role="alert">
                      {editing.error}
                    </span>
                  )}
                </>
              ) : (
                <button
                  aria-selected={active}
                  data-testid={`timeline-tab-${timeline.name}`}
                  onClick={() => switchTo(timeline)}
                  onDoubleClick={() =>
                    setRenaming({
                      id: timeline.id,
                      draft: timeline.name,
                      error: null,
                    })
                  }
                  role="tab"
                  title={t("clip:tabs.renameHint")}
                  type="button"
                >
                  {timeline.name}
                </button>
              )}
              <button
                aria-label={t("clip:tabs.delete", { name: timeline.name })}
                className="timeline-tab-close"
                data-testid={`timeline-tab-close-${timeline.name}`}
                onClick={() => askToRemove(timeline)}
                title={t("clip:tabs.deleteHint")}
                type="button"
              >
                ×
              </button>
            </span>
          );
        })}
        <button
          aria-label={t("clip:tabs.add")}
          className="timeline-tab-add"
          data-testid="timeline-tab-add"
          onClick={() => setNewTimelineOpen(true)}
          title={t("clip:tabs.addHint")}
          type="button"
        >
          +
        </button>
      </div>
      {asked &&
        // The question covers the whole window, so it is asked from the
        // window's own box rather than from the bar the strip stands on: the
        // bar blurs what is behind it, and a blur makes an element the box its
        // fixed children are laid out in — a dialog left inside it would hang
        // off the top of the window instead of sitting in the middle of it.
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
    </>
  );
}

/** The light question a timeline with clips on it is deleted under. */
function RemoveTimelineDialog({
  timeline,
  onCancel,
  onConfirm,
}: {
  timeline: TimelineDocument;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const count = timeline.clips.length;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <div
        aria-labelledby="remove-timeline-title"
        aria-modal="true"
        className="dialog"
        role="alertdialog"
      >
        <h2 id="remove-timeline-title">{t("clip:tabs.deleteTitle")}</h2>
        <p>
          {t("clip:tabs.deleteBody", {
            name: timeline.name,
            total: count,
            noun: t(
              count === 1 ? "clip:common.clipOne" : "clip:common.clipMany",
            ),
          })}
        </p>
        <div className="dialog-actions">
          <button onClick={onCancel} type="button">
            {t("clip:common.cancel")}
          </button>
          <button
            autoFocus
            className="primary"
            onClick={onConfirm}
            type="button"
          >
            {t("clip:tabs.deleteConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
