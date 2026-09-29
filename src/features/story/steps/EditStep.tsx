import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { StoryDocument } from "../../../shared/domain/types";
import { findResource } from "../../../shared/domain/validate";
import { i18n } from "../../../shared/i18n";
import { useAppStore } from "../../editor/stores/appStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useModelStore } from "../../settings/modelStore";
import {
  assemblySummary,
  planAssembly,
  type AssemblyPlan,
  type AssemblyWarning,
} from "../assembly";
import { AssembleTrouble, assembleStory } from "../assembleStory";
import { planDubbing, type DubWarning } from "../dubbing";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StoryImportButton } from "../components/StoryImportButton";
import { FilmCard } from "../panels/FilmCard";
import { useStoryStore } from "../stores/storyStore";

/** How many warnings are listed before the rest are counted. */
const WARNINGS_SHOWN = 5;

/**
 * The fifth step: a telling's clips laid end to end, rendered, and handed over.
 *
 * The step does two things and says what it is doing at each: it assembles the
 * clips the fourth step made onto a timeline of the telling's own, and it asks
 * the server to render that timeline into one file. Neither is guessed at —
 * the plan behind the assembly is shown before it is applied, and a machine
 * that cannot render says so rather than failing when pressed.
 */
export function EditStep({ story }: { story: StoryDocument }) {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const [withSubtitles, setWithSubtitles] = useState(true);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const plan: AssemblyPlan =
    moka === null
      ? { units: [], warnings: [], totalPlannedMs: 0 }
      : planAssembly(story, moka);
  // How the lines lie inside their shots — what is too long for its window, and
  // what nobody measured — is worth saying before the cut is rendered rather
  // than discovered in the finished film.
  const dubbing =
    moka === null
      ? undefined
      : planDubbing(
          story,
          plan.units,
          (assetId) => findResource(moka, assetId)?.probe?.durationMs,
        );
  const warnings: Array<AssemblyWarning | DubWarning> = [
    ...plan.warnings,
    ...(dubbing?.warnings ?? []),
  ];
  const timeline = (moka?.timelines ?? []).find(
    (held) => held.id === story.edit.timelineId,
  );
  const spoken = story.chapters
    .flatMap((chapter) => chapter.acts)
    .flatMap((act) => act.keyframes)
    .some((keyframe) => keyframe.dialogue.length > 0);
  // A telling that has been voiced or scored brings rows of its own with it,
  // and a clip that carries its own sound is worth warning about before a
  // reader hears two scores fighting in the cutting room.
  const sounded = story.chapters.some((chapter) =>
    chapter.acts.some(
      (act) => act.voice !== undefined || act.music !== undefined,
    ),
  );
  const videoSound =
    useModelStore.getState().view?.preferences.video.generateAudio === true;
  const mine = new Set(
    (story.edit.clipByAct ?? []).map((entry) => entry.clipId),
  );
  // A timeline the reader has also worked on: what is on it and not this
  // story's, or this story's clips that somebody has since taken away.
  const foreign =
    timeline === undefined
      ? 0
      : timeline.clips.filter((clip) => !mine.has(clip.id)).length +
        (mine.size > 0
          ? [...mine].filter(
              (clipId) => !timeline.clips.some((clip) => clip.id === clipId),
            ).length
          : 0);

  const assemble = async () => {
    setBusy(true);
    setAsking(false);
    try {
      const made = await assembleStory(story.id, { withSubtitles });
      useAppStore.getState().pushToast(
        "success",
        i18n.t("story:edit.assembled", {
          count: made.units,
          seconds: made.seconds,
        }),
      );
    } catch (problem) {
      useAppStore
        .getState()
        .pushToast(
          "error",
          problem instanceof Error ? problem.message : String(problem),
          undefined,
          problem instanceof AssembleTrouble ? problem.detail : undefined,
        );
    } finally {
      setBusy(false);
    }
  };

  const pressAssemble = () => {
    if (foreign > 0) {
      setAsking(true);
      return;
    }
    void assemble();
  };

  return (
    <div className="story-step-scroll" data-testid="story-step-edit-body">
      <div className="story-step-wide">
        <div className="story-step-bar">
          <p className="story-step-lead">{t("story:edit.lead")}</p>
          <StoryImportButton story={story} target="timeline" />
        </div>

        <section className="story-assembly" data-testid="story-assembly">
          <h3>{t("story:edit.assemble")}</h3>
          <p className="story-hint" data-testid="story-assembly-summary">
            {assemblySummary(story, plan)}
          </p>

          <label className="story-check">
            <input
              checked={withSubtitles}
              data-testid="story-assembly-subtitles"
              disabled={!spoken}
              onChange={(event) => setWithSubtitles(event.target.checked)}
              type="checkbox"
            />
            {t("story:edit.withSubtitles")}
          </label>
          <p className="story-hint">
            {spoken ? t("story:edit.subtitlesNote") : t("story:edit.noLines")}
          </p>

          {sounded && (
            <p className="story-hint" data-testid="story-assembly-sound">
              {t("story:edit.soundNote")}
              {videoSound ? ` ${t("story:edit.ownSoundNote")}` : ""}
            </p>
          )}

          {warnings.length > 0 && (
            <div
              className="story-warnings"
              data-testid="story-assembly-warnings"
            >
              <ul>
                {warnings.slice(0, WARNINGS_SHOWN).map((warning, at) => (
                  <li key={at}>
                    <span>{warningLine(warning)}</span>
                    <button
                      className="link"
                      data-testid={`story-warning-go-${at}`}
                      onClick={() => goFill(warning.chapterId)}
                      type="button"
                    >
                      {t("story:edit.goFill")}
                    </button>
                  </li>
                ))}
                {warnings.length > WARNINGS_SHOWN && (
                  <li className="story-hint">
                    {t("story:edit.warnings", {
                      count: plan.warnings.length - WARNINGS_SHOWN,
                    })}
                  </li>
                )}
              </ul>
            </div>
          )}
        </section>

        <FilmCard
          assembleBlocked={
            plan.units.length === 0 ? t("story:edit.nothingToAssemble") : null
          }
          assembling={busy}
          onAssembleAgain={pressAssemble}
          story={story}
          timeline={timeline}
          withSubtitles={withSubtitles}
        />

        <section className="story-film-clips" data-testid="story-clips">
          <h3>{t("story:edit.clips", { count: plan.units.length })}</h3>
          <ol className="story-clip-list">
            {plan.units.map((unit, at) => (
              <li
                className="story-clip-row"
                data-testid={`story-clip-${at}`}
                key={`${unit.actId}:${unit.keyframeId ?? ""}`}
              >
                <span className="story-col-index">{at + 1}</span>
                <span>
                  {unit.keyframeId === undefined
                    ? t("story:edit.clipLine", {
                        chapter: unit.chapterIndex,
                        act: unit.actIndex,
                      })
                    : t("story:edit.clipFrameLine", {
                        chapter: unit.chapterIndex,
                        act: unit.actIndex,
                        shot: shotNumber(story, unit.keyframeId),
                      })}
                </span>
                <span className="story-count">
                  {(unit.durationMs / 1000).toFixed(1)}s
                </span>
              </li>
            ))}
            {plan.units.length === 0 && (
              <li className="story-hint" data-testid="story-clips-empty">
                {t("story:edit.nothingToAssemble")}
              </li>
            )}
          </ol>
        </section>
      </div>

      {asking && (
        <ConfirmDialog
          body={t("story:edit.rebuildBody")}
          confirm={t("story:edit.rebuildConfirm")}
          onCancel={() => setAsking(false)}
          onConfirm={() => void assemble()}
          testId="rebuild-timeline"
          title={t("story:edit.rebuildTitle", { count: foreign })}
        />
      )}
    </div>
  );
}

/** Which shot of its act a shot is, counted from one. */
function shotNumber(story: StoryDocument, keyframeId: string): number {
  for (const chapter of story.chapters) {
    for (const act of chapter.acts) {
      const at = act.keyframes.findIndex((held) => held.id === keyframeId);
      if (at >= 0) return at + 1;
    }
  }
  return 0;
}

/** One warning, in the reader's language. */
function warningLine(warning: AssemblyWarning | DubWarning): string {
  if (warning.kind === "lineOverrun") {
    return i18n.t("story:edit.lineOverrun", {
      place: warning.place,
      over: ((warning.overMs ?? 0) / 1000).toFixed(1),
    });
  }
  return i18n.t(`story:edit.${warning.kind}`, { place: warning.place });
}

/** Standing on the step where the missing clip can be made. */
function goFill(chapterId: string): void {
  useStoryStore.getState().openChapter(chapterId);
  useStoryStore.getState().goStep("storyboard");
}
