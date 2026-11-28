import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../editor/stores/projectStore";
import { closeTimeline, switchTimeline } from "../interactions/timelineSwitch";
import { useClipStore } from "../stores/clipStore";
import { useOpenTimelines } from "../stores/openTimelines";

/**
 * The strip of the cuts that are open.
 *
 * As with the boards' own strip, this is the tabs this machine was left with
 * rather than every cut the project holds: a tab is a way of looking at a cut
 * and not the cut itself, so the small × puts it down without touching the
 * document, and the last tab is not closable. Opening a cut — from the rail's
 * selector, or by making a new one — puts its tab up. Renaming and deleting a
 * cut stay in the rail's selector, where every cut is a row whether it is open
 * or not.
 */
export function TimelineTabs() {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const activeTimelineId = useClipStore((state) => state.activeTimelineId);
  const setNewTimelineOpen = useClipStore((state) => state.setNewTimelineOpen);
  const openIds = useOpenTimelines((state) => state.ids);
  const timelines = (moka?.timelines ?? []).filter((timeline) =>
    openIds.includes(timeline.id),
  );

  return (
    <div
      aria-label={t("clip:tabs.list")}
      className="timeline-tabs"
      role="tablist"
    >
      {timelines.map((timeline) => {
        const active = timeline.id === activeTimelineId;
        const count = timeline.clips.length;
        return (
          <span
            className={active ? "timeline-tab is-active" : "timeline-tab"}
            key={timeline.id}
          >
            <button
              aria-selected={active}
              data-testid={`timeline-tab-${timeline.name}`}
              onClick={() => switchTimeline(timeline)}
              role="tab"
              title={`${count} ${t(
                count === 1 ? "clip:common.clipOne" : "clip:common.clipMany",
              )}`}
              type="button"
            >
              {timeline.name}
            </button>
            {timelines.length > 1 && (
              <button
                aria-label={t("clip:tabs.close", { name: timeline.name })}
                className="timeline-tab-close"
                data-testid={`timeline-tab-close-${timeline.name}`}
                onClick={() => closeTimeline(timeline.id)}
                title={t("clip:tabs.closeHint")}
                type="button"
              >
                ×
              </button>
            )}
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
  );
}
