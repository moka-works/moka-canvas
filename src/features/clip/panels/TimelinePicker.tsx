import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../editor/stores/projectStore";
import { PlusIcon, TimelineIcon } from "../components/ClipIcons";
import { switchTimeline } from "../interactions/timelineSwitch";
import { useClipStore } from "../stores/clipStore";

/**
 * Every cut the project holds, as the rail's selector reads them.
 *
 * A project tells a handful of timelines and they all have a tab across the
 * bar; this face is the same list read down the column, for a reader who is
 * choosing a cut rather than stepping to the next one. Pressing a row opens
 * that cut in the stage — the tab it already has turns over — and a project
 * with no cut yet is offered the one thing there is to do.
 */
export function TimelinePicker() {
  const { t } = useTranslation();
  const timelines = useProjectStore((state) => state.moka?.timelines ?? []);
  const activeId = useClipStore((state) => state.activeTimelineId);

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
            const count = timeline.clips.length;
            return (
              <li key={timeline.id}>
                <button
                  aria-current={active ? "true" : undefined}
                  className={
                    active ? "clip-timeline-row is-active" : "clip-timeline-row"
                  }
                  data-testid={`timeline-picker-${timeline.name}`}
                  onClick={() => switchTimeline(timeline)}
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
    </div>
  );
}
