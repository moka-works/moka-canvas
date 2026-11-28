import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  MAX_CANVAS_NAME_LENGTH,
  TIMELINE_NAME_MAX,
  chapterCut,
  type StoryChapter,
  type StoryDocument,
} from "../../../shared/domain";
import { useProjectStore } from "../../editor/stores/projectStore";
import { hasCanvasImport, importStoryToCanvas } from "../importCanvas";
import { importStoryToTimeline } from "../importTimeline";
import { ImportDialog } from "./ImportDialog";

/** Which room a telling is imported into. */
export type ImportTarget = "canvas" | "timeline";

/**
 * Taking the telling into the canvas, or one episode into the cutting room,
 * from wherever it has been worked on.
 *
 * The offer is one button and a question — what the thing being made is called.
 * Whether there is anything to import is read off the telling rather than
 * guessed at: a story whose steps have made nothing offers nothing, and an
 * episode that has not been assembled offers no cut; either says why the
 * button is dead rather than opening a question with no answer.
 */
export function StoryImportButton({
  story,
  target,
  chapter,
}: {
  story: StoryDocument;
  target: ImportTarget;
  /** The episode a cut is copied from; the canvas takes the whole telling. */
  chapter?: StoryChapter;
}) {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const [open, setOpen] = useState(false);
  const cut = chapter === undefined ? undefined : chapterCut(story, chapter.id);
  const cutTimeline =
    cut === undefined
      ? undefined
      : (moka?.timelines ?? []).find(
          (timeline) => timeline.id === cut.timelineId,
        );
  const ready =
    target === "canvas"
      ? hasCanvasImport(story)
      : cutTimeline !== undefined && cutTimeline.clips.length > 0;
  const empty =
    target === "canvas"
      ? t("story:import.canvas.empty")
      : cutTimeline === undefined
        ? t("story:import.timeline.notAssembled")
        : t("story:import.timeline.empty");

  const run = (name: string): boolean => {
    const held = useProjectStore.getState().moka;
    if (held === null) return false;
    if (target === "canvas")
      return importStoryToCanvas(story, held, name) !== null;
    if (chapter === undefined) return false;
    return importStoryToTimeline(story, held, chapter, name) !== null;
  };

  return (
    <>
      <button
        className="story-import"
        data-testid={`story-import-${target}`}
        disabled={!ready}
        onClick={() => setOpen(true)}
        title={ready ? undefined : empty}
        type="button"
      >
        {t(`story:import.${target}.button`)}
      </button>
      {open && (
        <ImportDialog
          confirm={t(`story:import.${target}.title`)}
          defaultName={
            target === "canvas"
              ? story.name
              : t("story:import.timeline.name", {
                  name: story.name,
                  chapter: chapter?.title ?? "",
                })
          }
          hint={t(`story:import.${target}.hint`)}
          maxLength={
            target === "canvas" ? MAX_CANVAS_NAME_LENGTH : TIMELINE_NAME_MAX
          }
          onClose={() => setOpen(false)}
          onImport={run}
          testId={`story-import-${target}-dialog`}
          title={t(`story:import.${target}.title`)}
        />
      )}
    </>
  );
}
