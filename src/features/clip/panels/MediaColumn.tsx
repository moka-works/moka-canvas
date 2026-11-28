import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { AssetId, ResourceEntry } from "../../../shared/domain";
import { timelineAssetIds } from "../../../shared/domain";
import { AssetShelf } from "../../editor/panels/AssetShelf";
import { useEditorStore } from "../../editor/stores/editorStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { addAssetAtPlayhead } from "../interactions/clipActions";
import { useClipStore, type ClipFace } from "../stores/clipStore";
import { AdjustPanel } from "./AdjustPanel";
import { FiltersPanel } from "./FiltersPanel";
import { faceShelf, isMediaFace } from "./mediaLenses";
import {
  previewKindOf,
  stopMediaPreview,
  toggleMediaPreview,
  useMediaPreview,
} from "./mediaPreview";
import { TextPanel } from "./TextPanel";
import { TimelinePicker } from "./TimelinePicker";

const TITLES: Record<ClipFace, string> = {
  timelines: "clip:mediaColumn.timelines",
  cut: "clip:mediaColumn.cut",
  text: "clip:mediaColumn.text",
  filters: "clip:mediaColumn.filters",
  adjust: "clip:mediaColumn.adjust",
};

/** The row's own small offer on a sound or a picture in motion: hear it, or
    watch it in the card beside the shelf, before it is laid down. */
function PreviewAction({ entry }: { entry: ResourceEntry }) {
  const { t } = useTranslation();
  const preview = useMediaPreview();
  const kind = previewKindOf(entry);
  if (kind === null) return null;
  const playing = preview.assetId === entry.id && preview.playing;
  return (
    <button
      aria-label={t(
        playing ? "clip:mediaColumn.pauseAria" : "clip:mediaColumn.playAria",
        { name: entry.name },
      )}
      aria-pressed={playing}
      className={`resource-action clip-media-action${
        playing ? " is-playing" : ""
      }`}
      data-testid="clip-media-preview"
      onClick={() => {
        // A video plays where a file is read, so asking for one is also asking
        // the card to show it; a sound plays from the row itself.
        if (kind === "video") useClipStore.getState().selectMedia(entry.id);
        toggleMediaPreview(entry.id, kind);
      }}
      title={
        playing
          ? t("clip:mediaColumn.pausePreview")
          : t(
              kind === "audio"
                ? "clip:mediaColumn.previewSound"
                : "clip:mediaColumn.previewVideo",
            )
      }
      type="button"
    >
      {playing ? "⏸" : "▶"}
    </button>
  );
}

/** The row's own small offer: the file lands where the playhead is. */
function AddAtPlayheadAction({ entry }: { entry: ResourceEntry }) {
  const { t } = useTranslation();
  return (
    <button
      aria-label={t("clip:mediaColumn.addAria", { name: entry.name })}
      className="resource-action clip-media-action"
      data-testid="clip-media-add"
      onClick={() => addAssetAtPlayhead(entry.id)}
      title={t("clip:common.addAtPlayhead")}
      type="button"
    >
      ＋
    </button>
  );
}

/** The row actions the cut's face adds to the shelf's own. */
function mediaRowExtras(entry: ResourceEntry) {
  return (
    <>
      <PreviewAction entry={entry} />
      <AddAtPlayheadAction entry={entry} />
    </>
  );
}

/** Reads the row a reader chose, which the material card in the inspector reads. */
function chooseMedia(id: AssetId) {
  useClipStore.getState().selectMedia(id);
}

/** The way to the whole project's shelf: the picker, in its placing mode. */
function fromTheProject() {
  useEditorStore.getState().openAssetPicker({ mode: "place" });
}

/**
 * The column between the rail and the stage.
 *
 * One face reads the cut's own material — the files the open timeline's clips
 * hold, through the lens mediaLenses says — with each row carrying the room's
 * own offers: trying a sound or a video before it is used, and landing the
 * file at the playhead. Files brought in and placed nowhere wait in the tray
 * above the list, and what the whole project holds is one press away in the
 * picker rather than a second question in the column. The other three faces
 * are the room's quick tools: the words written on the cut, the looks a clip
 * can wear, and the sliders that grade it, the last two working on whatever
 * the timeline holds chosen.
 */
export function MediaColumn() {
  const { t } = useTranslation();
  const face = useClipStore((state) => state.face);
  const mediaSelection = useClipStore((state) => state.mediaSelection);
  const playing = useClipStore((state) => state.playing);
  const activeTimelineId = useClipStore((state) => state.activeTimelineId);
  const moka = useProjectStore((state) => state.moka);
  // What this cut is made of, read once per document and timeline rather than
  // once per row: the lens the shelf narrows through.
  const held = useMemo(() => {
    const timeline = moka?.timelines?.find(
      (item) => item.id === activeTimelineId,
    );
    return new Set(timeline ? timelineAssetIds(timeline) : []);
  }, [moka, activeTimelineId]);
  const shelf = useMemo(
    () => (isMediaFace(face) ? faceShelf({ held }) : null),
    [face, held],
  );
  const title = t(TITLES[face]);

  // A preview belongs to the moment it was asked for: leaving the face puts
  // the sound away rather than letting it follow the reader to another face.
  useEffect(() => () => stopMediaPreview(), [face]);
  // And the cut has the room to itself: a preview gives way the moment the
  // transport starts, so the two are never heard over each other.
  useEffect(() => {
    if (playing) stopMediaPreview();
  }, [playing]);

  return (
    <>
      {shelf ? (
        <>
          <div className="clip-media-head">
            <h2>{title}</h2>
            <button
              className="clip-media-project"
              data-testid="clip-from-project"
              onClick={fromTheProject}
              title={t("clip:mediaColumn.fromProjectHint")}
              type="button"
            >
              {t("clip:mediaColumn.fromProject")}
            </button>
          </div>
          <div className="clip-media-scroll">
            <AssetShelf
              key={face}
              {...shelf}
              emptyText={t(shelf.emptyText)}
              onSelect={chooseMedia}
              rowExtras={mediaRowExtras}
              selectedId={mediaSelection}
              unplaced={{
                titleKey: "assets:shelf.unplaced",
                action: (entry) => (
                  <>
                    <PreviewAction entry={entry} />
                    <AddAtPlayheadAction entry={entry} />
                  </>
                ),
              }}
            />
          </div>
        </>
      ) : (
        <>
          <div className="clip-column-head">
            <h2>{title}</h2>
          </div>
          <div className="clip-column-body">
            {face === "timelines" ? (
              <TimelinePicker />
            ) : face === "text" ? (
              <TextPanel />
            ) : face === "filters" ? (
              <FiltersPanel />
            ) : (
              <AdjustPanel />
            )}
          </div>
        </>
      )}
    </>
  );
}
