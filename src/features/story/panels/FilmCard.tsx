import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { isApiError } from "../../../api/client";
import type {
  StoryDocument,
  TimelineDocument,
} from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { useAppStore } from "../../editor/stores/appStore";
import { saveTrouble, useProjectStore } from "../../editor/stores/projectStore";
import { askSavePath, fileSafeName } from "../../editor/launcher/savePath";
import { clipApi, type ClipCapabilities } from "../../clip/api";
import { useClipStore } from "../../clip/stores/clipStore";
import { useExportStore } from "../../clip/stores/exportStore";
import { assemblyCarries, assemblyDigest, planAssembly } from "../assembly";
import { assembleStory } from "../assembleStory";
import { saveEverything } from "../stores/storyJobStore";
import { useStoryExportStore } from "../stores/storyExportStore";

/** How often a running render is looked at, in milliseconds. */
const POLL_MS = 700;

/**
 * The finished film: what rendering the telling produced, and the one button
 * that makes it.
 *
 * Rendering is the server's work from the moment it is asked for, so nothing
 * here decides anything about the artifact — it asks where the file should
 * land, it watches, and it says where the file went. The file is the reader's,
 * at the path they chose: nothing about it is written down in the telling.
 *
 * The assembly's own way in lives here too: the buttons that used to stand
 * above the card are gone, so the link that lays the clips out is this card's,
 * and it says why it cannot be pressed when there is nothing to lay out.
 */
export function FilmCard({
  story,
  timeline,
  withSubtitles,
  assembleBlocked,
  assembling,
  onAssembleAgain,
}: {
  story: StoryDocument;
  /** The timeline the telling was laid down on, if the document still has it. */
  timeline: TimelineDocument | undefined;
  /** Whether the lines are written on the film as a caption track. */
  withSubtitles: boolean;
  /** Why the clips cannot be laid out, if they cannot. */
  assembleBlocked: string | null;
  /** Whether an assembly is already on its way. */
  assembling: boolean;
  onAssembleAgain: () => void;
}) {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const task = useStoryExportStore((state) => state.task);
  const error = useStoryExportStore((state) => state.error);
  const [capabilities, setCapabilities] = useState<ClipCapabilities | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const live = task?.status === "queued" || task?.status === "running";
  // Where the last render of this session went, held while the process runs:
  // this card is the only place a reader is told it.
  const savedTo = task?.status === "done" ? task.savedTo : undefined;
  // Whether the film is behind the telling: what the assembly would lay down
  // now, read the same way the assembly reads it, against what was written
  // down when the timeline was last laid down. A telling that has never been
  // assembled is behind by definition, and pressing export assembles it.
  const plan = moka === null ? undefined : planAssembly(story, moka);
  const behind =
    moka === null ||
    plan === undefined ||
    assemblyDigest(story, moka, plan, {
      withSubtitles,
      ...(story.edit.timelineId === undefined
        ? {}
        : { timelineId: story.edit.timelineId }),
    }) !== story.edit.assembledDigest;
  // What the film will carry, counted from the same plan the digest is taken
  // from: what is heard, and whether the words are written on it.
  const carried =
    plan === undefined || moka === null
      ? undefined
      : assemblyCarries(story, moka, plan);

  // What this machine can do, asked once: the answer cannot change while the
  // process runs, and a machine without a renderer is not a broken step — it is
  // a step that says so and offers nothing to press.
  useEffect(() => {
    let alive = true;
    clipApi
      .capabilities()
      .then((answer) => {
        if (alive) setCapabilities(answer);
      })
      .catch((problem: Error) => {
        if (alive) useStoryExportStore.getState().setError(problem.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  // A finished render has nowhere to be filed — the file is the reader's, at
  // the path they chose — so all that is left to do is say so, once, and offer
  // the way into the cutting room where the same telling can be worked on.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (task?.status !== "done" || task.savedTo === undefined) return;
    if (announced.current === task.id) return;
    announced.current = task.id;
    useAppStore
      .getState()
      .pushToast(
        "success",
        i18n.t("story:edit.filmSaved", { path: task.savedTo }),
        {
          label: i18n.t("story:edit.openInClip"),
          go: () => openInCuttingRoom(story.id),
        },
      );
  }, [task, story.id]);

  // Polling while a render is live, and only then.
  useEffect(() => {
    if (task === null || !live) return;
    const id = task.id;
    const timer = window.setInterval(() => {
      clipApi
        .status(id)
        .then((next) => useStoryExportStore.getState().setTask(next))
        .catch((problem: Error) =>
          useStoryExportStore.getState().setError(problem.message),
        );
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [task?.id, live, task]);

  const start = async () => {
    setBusy(true);
    useStoryExportStore.getState().setError(null);
    try {
      // A retry of a render that failed or was stopped goes where that render
      // was going; a fresh export starts by asking, since a render that made
      // its film already has a file that must not be quietly written over.
      const held = useStoryExportStore.getState();
      const again = held.task !== null && held.task.status !== "done";
      const destination = again
        ? held.destination
        : await askSavePath({
            title: t("story:edit.saveTitle"),
            defaultName: `${fileSafeName(timeline?.name ?? story.name)}.mp4`,
            extensions: ["mp4"],
          });
      if (destination === null) return;
      useStoryExportStore.getState().setDestination(destination);
      // A telling that has moved on since it was laid down is assembled again
      // first: a render of the older timeline is a film of a telling that is no
      // longer there, which is exactly the one a reader would not have asked
      // for. The save is what puts the new assembly where the server can read
      // it, and the render is the server's, so the order is assemble, save,
      // render.
      const target = behind
        ? (await assembleStory(story.id, { withSubtitles })).timelineId
        : timeline?.id;
      if (target === undefined) return;
      if (!(await saveEverything())) {
        const blocked = saveTrouble();
        throw new Error(
          blocked.detail === undefined
            ? blocked.message
            : `${blocked.message} ${blocked.detail}`,
        );
      }
      const started = await clipApi.start(target, destination);
      useStoryExportStore.getState().setTask(started);
    } catch (problem) {
      useStoryExportStore
        .getState()
        .setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (task === null) return;
    setBusy(true);
    try {
      const stopped = await clipApi.cancel(task.id);
      useStoryExportStore.getState().setTask(stopped);
    } catch (problem) {
      useStoryExportStore
        .getState()
        .setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  // What stops the export: a machine that cannot render, or a telling with
  // nothing to render. A timeline that is behind is not a reason to stop —
  // pressing export assembles it again first — so those two blocks lift while
  // the assembly is owed.
  const blocked = !capabilities?.available
    ? (capabilities?.reason ?? t("story:edit.noFfmpeg"))
    : !behind && timeline === undefined
      ? t("story:edit.noTimeline")
      : !behind && timeline !== undefined && timeline.clips.length === 0
        ? t("story:edit.nothingToRender")
        : null;
  const problem =
    error ??
    (task !== null && !live && task.status !== "done"
      ? task.message
      : undefined);
  const refused = isApiError(error, "BUSY");

  return (
    <section className="story-film-card" data-testid="story-film">
      <h3>{t("story:edit.film")}</h3>

      {/* What this machine can do, in words rather than in a button's title:
          a reader whose host cannot render should read why without hovering. */}
      {capabilities !== null && !capabilities.available && (
        <p className="story-hint" data-testid="story-film-capability">
          {capabilities.reason ?? t("story:edit.noFfmpeg")}
        </p>
      )}

      {savedTo !== undefined && (
        <p className="story-hint" data-testid="story-film-saved">
          {t("story:edit.filmSaved", { path: savedTo })}
        </p>
      )}

      {/* Whether the film is the telling as it stands, and what it carries:
          a reader deciding to export from here should not have to remember
          what the step said two presses ago. */}
      {!live && (
        <p className="story-hint" data-testid="story-film-freshness">
          {behind ? t("story:edit.filmBehind") : t("story:edit.filmFresh")}
        </p>
      )}
      {!live && carried !== undefined && (
        <p className="story-hint" data-testid="story-film-carries">
          {t("story:edit.filmCarries", {
            voices: carried.voices,
            music: carried.music,
            subtitles: withSubtitles
              ? t("story:edit.subtitlesOn")
              : t("story:edit.subtitlesOff"),
          })}
        </p>
      )}

      {live && task !== null && (
        <div className="clip-export-progress" data-testid="story-film-progress">
          <div
            aria-label={t("story:edit.exporting")}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(task.progress01 * 100)}
            className="clip-export-bar"
            role="progressbar"
          >
            <span style={{ width: `${Math.round(task.progress01 * 100)}%` }} />
          </div>
          <p className="clip-export-percent">
            {`${Math.round(task.progress01 * 100)}%`}
          </p>
        </div>
      )}

      {problem !== undefined && (
        <p className="story-hint" data-testid="story-film-error" role="alert">
          {problem}
          {refused && (
            <button
              className="link"
              data-testid="story-film-watch"
              onClick={() => openInCuttingRoom(story.id, true)}
              type="button"
            >
              {t("story:edit.watchExport")}
            </button>
          )}
        </p>
      )}

      <div className="story-step-actions">
        {live ? (
          <button
            data-testid="story-film-cancel"
            disabled={busy}
            onClick={() => void cancel()}
            type="button"
          >
            {t("story:panels.cancel")}
          </button>
        ) : (
          <button
            className="primary"
            data-testid="story-film-export"
            disabled={busy || blocked !== null}
            onClick={() => void start()}
            title={blocked ?? undefined}
            type="button"
          >
            {behind
              ? t("story:edit.exportFresh")
              : savedTo === undefined
                ? t("story:edit.export")
                : t("story:edit.exportAgain")}
          </button>
        )}
        {/* The way into the cutting room is the timeline's, not the film's: a
            cut that has only been assembled is exactly the one a reader wants
            to go on working on. */}
        {timeline !== undefined && (
          <button
            data-testid="story-film-open"
            onClick={() => void openInCuttingRoom(story.id)}
            type="button"
          >
            {t("story:edit.openInClip")}
          </button>
        )}
        <button
          className="link"
          data-testid="story-film-reassemble"
          disabled={assembling || assembleBlocked !== null}
          onClick={onAssembleAgain}
          title={assembleBlocked ?? undefined}
          type="button"
        >
          {t("story:edit.reassemble")}
        </button>
      </div>
    </section>
  );
}

/**
 * Leaves the story room for the cutting room, with this telling's timeline open.
 *
 * The project is flushed first: a film is exported from the timeline the server
 * holds, and one that is still in this window is a timeline it has never heard
 * of. The telling is read again after that flush, for the same reason and for
 * the toast that offers this way over: it holds the telling from the moment the
 * offer was made, which the room may have written to since. A save that cannot
 * land keeps the reader where they are rather than walking away from work.
 */
async function openInCuttingRoom(
  storyId: string,
  withExportDialog = false,
): Promise<void> {
  const project = useProjectStore.getState();
  await project.flush();
  const after = useProjectStore.getState();
  if (after.pending.length > 0 || after.saveStatus === "conflicted") {
    useAppStore
      .getState()
      .pushToast(
        "error",
        after.saveStatus === "conflicted"
          ? i18n.t("story:page.saveConflict")
          : (after.saveError ?? i18n.t("story:page.saveFailed")),
      );
    return;
  }
  const story = (after.moka?.stories ?? []).find((held) => held.id === storyId);
  if (story?.edit.timelineId === undefined) return;
  useClipStore.getState().setActiveTimeline(story.edit.timelineId);
  useAppStore.getState().setPhase("clip");
  if (withExportDialog) {
    useExportStore.getState().setOpen(true);
    useExportStore.getState().setTask(null);
  }
}
