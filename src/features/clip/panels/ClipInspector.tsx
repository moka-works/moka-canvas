import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AssetId, MokaFile, ResourceEntry } from "../../../shared/domain";
import { PanelFold } from "../../editor/components/PanelFold";
import { useProjectStore } from "../../editor/stores/projectStore";
import { AgentDock } from "../../assistant/agent/AgentDock";
import { SelectIcon } from "../components/ClipIcons";
import { useClipStore } from "../stores/clipStore";
import { ClipFields } from "../inspector/ClipFields";
import { MediaCard } from "../inspector/MediaCard";
import { TimelineCard } from "../inspector/TimelineCard";
import { TransitionCard } from "../inspector/TransitionCard";

/**
 * The column on the right of the cutting room.
 *
 * What is chosen decides what the column is about, and the choice is read in
 * one fixed order: a seam beats the clips it joins, the clips beat the file
 * chosen on the shelf, and nothing chosen is the timeline itself. A file and
 * a clip can both be held at once — the two columns each keep their own
 * highlight — and the clip wins, because a reader with a clip chosen is
 * cutting and a reader with only a file chosen is looking for one to lay
 * down.
 */

/** The file an id names, wherever on the shelf it is filed, or null. */
function findEntry(
  moka: MokaFile | null,
  assetId: AssetId,
): ResourceEntry | null {
  for (const entries of Object.values(moka?.resources ?? {})) {
    const found = entries.find((entry) => entry.id === assetId);
    if (found) return found;
  }
  return null;
}

export function ClipInspector() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"details" | "assistant">("details");
  const moka = useProjectStore((state) => state.moka);
  const activeTimelineId = useClipStore((state) => state.activeTimelineId);
  const selection = useClipStore((state) => state.selection);
  const mediaSelection = useClipStore((state) => state.mediaSelection);

  const timeline =
    (moka?.timelines ?? []).find((each) => each.id === activeTimelineId) ??
    null;
  const chosen = new Set(selection.clipIds);
  const clips = (timeline?.clips ?? []).filter((clip) => chosen.has(clip.id));
  const transition =
    timeline && selection.transitionId
      ? (timeline.transitions.find(
          (seam) => seam.id === selection.transitionId,
        ) ?? null)
      : null;
  const entry = mediaSelection ? findEntry(moka, mediaSelection) : null;

  return (
    <aside
      aria-label={t("clip:inspector.label")}
      className="clip-inspector"
      id="clip-panel-right"
    >
      <PanelFold side="right" />
      <div className="agent-panel-tabs" role="tablist">
        <button
          aria-selected={tab === "details"}
          className={tab === "details" ? "is-active" : ""}
          onClick={() => setTab("details")}
          role="tab"
          type="button"
        >
          {t("clip:inspector.label")}
        </button>
        <button
          aria-selected={tab === "assistant"}
          className={tab === "assistant" ? "is-active" : ""}
          onClick={() => setTab("assistant")}
          role="tab"
          type="button"
        >
          {t("agent:title")}
        </button>
      </div>
      {tab === "assistant" ? (
        <AgentDock room="clip" />
      ) : timeline && transition ? (
        <TransitionCard timeline={timeline} transition={transition} />
      ) : timeline && clips.length > 0 ? (
        <ClipFields clips={clips} timeline={timeline} />
      ) : entry ? (
        <MediaCard entry={entry} key={entry.id} timeline={timeline} />
      ) : timeline ? (
        <TimelineCard timeline={timeline} />
      ) : (
        <div className="clip-empty clip-empty-inspector">
          <SelectIcon size={26} />
          <p>{t("clip:inspector.empty")}</p>
        </div>
      )}
    </aside>
  );
}
