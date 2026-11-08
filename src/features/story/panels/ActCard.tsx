import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  actCast,
  actGranularity,
  actPlannedMs,
  currentTake,
  takeFile,
  type StoryGuess,
  voiceHoldsLine,
} from "../../../shared/domain";
import type {
  StoryAct,
  StoryActPatch,
  StoryActSound,
  StoryDocument,
  StoryShotGranularity,
} from "../../../shared/domain/types";
import { assetUrl } from "../../../api/assets";
import { MAX_ELEMENTS_PER_STORY } from "../../../shared/domain/constants";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { useProjectStore } from "../../editor/stores/projectStore";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RunningBar } from "../components/RunningBar";
import {
  actClipPieces,
  planActMusic,
  planActVideos,
  planElementArtWaves,
  planKeyframeArt,
  planLineVoiceAsks,
  videoCeiling,
} from "../jobs/plan";
import {
  useStoryBulkRun,
  useStoryRun,
  useStoryWavesAsk,
  useStoryWavesRun,
  type ActRun,
} from "../stores/storyJobStore";
import { KeyframeTable } from "./KeyframeTable";
import { ElementDraftDialog } from "./ElementDraftDialog";
import { ElementPictureInspector } from "./ElementPictureInspector";
import { elementFromDraft, type ElementDraft } from "./elementDraft";
import { liveStory } from "./removeOldTake";
import { RefPicker } from "./RefPicker";
import { StoryLightbox } from "./StoryLightbox";
import { secondsOf } from "./takes";
import { useField } from "./useField";
import { moved, writeActs } from "./writeBoard";

/** The longest an act and a shot may be edited to, in seconds. */
const ACT_TITLE_MAX = 40;

/** The two ways an act's clip may be made, in the order the room shows them. */
const GRANULARITY_OPTIONS: StoryShotGranularity[] = ["act", "keyframe"];

/**
 * One act of a board: who is in it, what happens, how it sounds, and the shots
 * it is made of, one row each.
 *
 * The card is where a board is edited and where its pictures and clip are
 * asked for: everything under the table — the frames and the clip — is made
 * from what is written above it, and what is written above it stays editable
 * afterwards, since a board is argued with rather than sealed. A picture is
 * only asked for once its own shot is written, and a clip once every shot has
 * its picture, because those are what the ask is made of.
 *
 * Every picture is an ask of its own: what this card's own painter is working
 * on is asked for once and says so, while the rest of the card — and the acts
 * beside it — go on being askable. Everything out for the act stands at its
 * head, a bar per batch: two things being made at once are two bars, each
 * counting its own time.
 */
export function ActCard({
  story,
  chapterId,
  act,
  index,
  last,
  guesses,
  busyKeyframes,
  busyClips,
  busyLines,
  videoBusy,
  voiceBusy,
  musicBusy,
  runs,
}: {
  story: StoryDocument;
  chapterId: string;
  act: StoryAct;
  /** Which act of the chapter this is, counted from zero as the room counts. */
  index: number;
  /** Whether this is the chapter's last act, which has nowhere to move down. */
  last: boolean;
  /** The cells of this act's board the reading chose rather than read. */
  guesses: StoryGuess[];
  /** The shots of this act being drawn just now, by the shot's own name. */
  busyKeyframes: Set<string>;
  /** The shots of this act being filmed just now. */
  busyClips: Set<string>;
  /** Whether this act's own clip is being made just now. */
  videoBusy: boolean;
  /** Whether any of this act's lines, or its score, are being made just now. */
  voiceBusy: boolean;
  musicBusy: boolean;
  /** The lines of this act being read just now, by the line's own name. */
  busyLines: Set<string>;
  /** The batches working in this act just now, each with its own clock. */
  runs: ActRun[];
}) {
  const { t } = useTranslation();
  const run = useStoryRun();
  const runBulk = useStoryBulkRun();
  const runWaves = useStoryWavesRun();
  const runArt = useStoryWavesAsk();
  const moka = useProjectStore((state) => state.moka);
  const [playing, setPlaying] = useState(false);
  const [removing, setRemoving] = useState(false);
  // The element whose picture the reader asked to look at, if any. Held by
  // name rather than by the object: a drawing that lands while the inspector
  // stands is the same element with one more take.
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  // The question a new reference picture is asked with.
  const [addingReference, setAddingReference] = useState(false);
  const inspecting =
    inspectingId === null
      ? null
      : (story.elements.find((held) => held.id === inspectingId) ?? null);
  const [sound, setSound] = useState<StoryActSound>(act.sound);
  /** The granularity a switch is waiting on, where the act has clips to keep. */
  const [granularityTo, setGranularityTo] =
    useState<StoryShotGranularity | null>(null);
  const granularity = actGranularity(act, story.shotGranularity);
  const perShot = granularity === "keyframe";
  const clip = currentTake(act.video);
  const voice = act.voice === undefined ? undefined : currentTake(act.voice);
  const music = act.music === undefined ? undefined : currentTake(act.music);

  const plannedMs = actPlannedMs(act);
  // How the clip will be asked for: one piece while the act fits in one of
  // the video model's clips, and otherwise several, cut where its shots end.
  // What the ask comes to is worth saying out loud when it is not the length
  // the board planned: a shot that outran one clip is made as long as it can
  // be, and an act filmed in pieces is made in pieces.
  const ceiling = videoCeiling();
  const pieces = actClipPieces(act, ceiling);
  const askedSeconds = pieces.reduce((sum, piece) => sum + piece.seconds, 0);
  const split = pieces.length > 1;
  const adjusted = pieces.length > 0 && askedSeconds * 1000 !== plannedMs;

  const write = (patch: StoryActPatch) =>
    writeAct(story, chapterId, act, patch);
  // An act found to be in the wrong place is moved, and everything it is made
  // of — its shots, its frames, its clip — travels with it, since the write
  // says where the acts stand rather than what they hold.
  const move = (by: number) => {
    const chapter = story.chapters.find((held) => held.id === chapterId);
    const acts = chapter?.acts ?? [];
    const to = index + by;
    if (to < 0 || to >= acts.length) return;
    writeActs(story, chapterId, moved(acts, index, to));
  };
  const removeAct = () => {
    const chapter = story.chapters.find((held) => held.id === chapterId);
    writeActs(
      story,
      chapterId,
      (chapter?.acts ?? []).filter((held) => held.id !== act.id),
    );
  };

  const title = useField(act.title, (value) => {
    const name = value.trim();
    if (name !== "" && name !== act.title) write({ title: name });
  });
  const summary = useField(act.summary, (value) => {
    if (value !== act.summary) write({ summary: value });
  });

  // A reference nobody has drawn cannot travel with the prompt, which is worth
  // saying before the frames are asked for rather than after: what comes back
  // is a picture of a stranger.
  const cast = actCast(story, act);
  const references = [...cast.characters, ...cast.scenes, ...cast.props];
  const undrawn = references.filter(
    (element) => currentTake(element.main) === undefined,
  );

  const missing = act.keyframes.filter(
    (keyframe) => keyframe.art.takes.length === 0,
  );
  // What this card's own draw button hands over: the shots still missing a
  // picture that are not already being drawn, since asking for a shot twice
  // pays for it twice. It is also what the button counts, so its number is the
  // work it would ask for — while a shot waits on its painter, the rest of the
  // missing ones go on being askable.
  const drawable = missing.filter(
    (keyframe) => !busyKeyframes.has(keyframe.id),
  );
  const drawn = act.keyframes.length - missing.length;
  // A clip is made from the pictures of the act: every shot of it is drawn
  // first, since what a clip of half-drawn shots would be made from is the
  // words alone. Whether those pictures are liked is not for the room to ask.
  const everyFrameDrawn = act.keyframes.length > 0 && missing.length === 0;
  const filmed = act.keyframes.filter(
    (keyframe) => keyframe.video.takes.length > 0,
  ).length;

  const drawMissing = () => {
    const items = planKeyframeArt(
      story,
      drawable.map((keyframe) => ({
        chapterId,
        actId: act.id,
        keyframeId: keyframe.id,
      })),
    );
    void runBulk(story.id, "keyframeArt", items);
  };

  const filmAct = () => {
    const items = planActVideos(story, chapterId, [act.id]);
    void run(story.id, "actVideo", items);
  };

  // What a switch would leave behind: every clip this act has, of either kind,
  // which is what the dialog counts before the reader decides.
  const actVideos =
    act.video.takes.length +
    act.keyframes.reduce(
      (sum, keyframe) => sum + keyframe.video.takes.length,
      0,
    );

  /** Records this act's own way of filming, which the other acts do not share. */
  const writeGranularity = (next: StoryShotGranularity) => {
    execute(i18n.t("story:history.storyboard"), [
      {
        type: "updateActGranularity",
        storyId: story.id,
        chapterId,
        actId: act.id,
        shotGranularity: next,
      },
    ]);
  };

  const chooseGranularity = (next: StoryShotGranularity) => {
    if (next === granularity) return;
    if (actVideos > 0) {
      setGranularityTo(next);
      return;
    }
    writeGranularity(next);
  };

  /**
   * A reference drawn for this act rather than found in the cast.
   *
   * The element is made first, because an ask needs a place to land, and it is
   * put into the act's own cast in the same step: a picture drawn here is one
   * the act is meant to use. The inspector then stands over the new place, so
   * the drawing is watched where it will be kept.
   */
  const addReference = (draft: ElementDraft) => {
    const element = elementFromDraft(story, {
      ...draft,
      chapterIds: [chapterId],
    });
    const cast: StoryActPatch =
      element.kind === "character"
        ? { characterIds: [...act.characterIds, element.id] }
        : element.kind === "scene"
          ? { sceneId: element.id }
          : { propIds: [...act.propIds, element.id] };
    const done = execute(i18n.t("story:history.newReference"), [
      {
        type: "setStoryElements",
        storyId: story.id,
        elements: [...story.elements, element],
      },
      {
        type: "updateStoryAct",
        storyId: story.id,
        chapterId,
        actId: act.id,
        patch: cast,
      },
    ]);
    if (done === null) return;
    setInspectingId(element.id);
    // The ask is planned from the document the element was just written into.
    const live = liveStory(story.id);
    if (live === undefined) return;
    void runArt(
      story.id,
      "elementArt",
      planElementArtWaves(live, [{ elementId: element.id, view: "main" }]),
    );
  };

  // The lines the act's button would ask for: the ones with nothing read for
  // them yet, and the ones whose words have changed since they were read. A
  // line being read just now is not one of them, since asking again would pay
  // for it twice; the old act-wide reading is not one either, and stays where
  // it is until the lines beside it are read one by one.
  const needing = act.keyframes.flatMap((keyframe) =>
    keyframe.dialogue.filter(
      (line) =>
        line.text.trim() !== "" &&
        !voiceHoldsLine(keyframe, line) &&
        !busyLines.has(line.id),
    ),
  );
  const spoken = act.keyframes
    .flatMap((keyframe) => keyframe.dialogue)
    .filter((line) => line.text.trim() !== "").length;
  const hasSound =
    act.sound.music.trim() !== "" ||
    act.sound.sfx.trim() !== "" ||
    (act.sound.ambience ?? "").trim() !== "";

  const speakAct = () => {
    // Only the lines short of a reading are asked for, so what is sent is
    // what the button counted.
    const waves = planLineVoiceAsks(
      story,
      chapterId,
      act.id,
      needing.map((line) => line.id),
    );
    void runWaves(story.id, "voice", waves);
  };

  const scoreAct = () => {
    const items = planActMusic(story, chapterId, act.id);
    void run(story.id, "music", items);
  };

  return (
    <li className="story-act" data-testid={`story-act-${index}`}>
      <div className="story-act-head">
        <span className="story-act-index">
          {t("story:storyboard.actIndex", { index: index + 1 })}
        </span>
        <input
          aria-label={t("story:storyboard.actTitle")}
          className="story-act-title"
          data-testid={`story-act-title-${index}`}
          maxLength={ACT_TITLE_MAX}
          onBlur={title.commit}
          onChange={(event) => title.set(event.target.value)}
          value={title.value}
        />
        <span className="story-count" data-testid={`story-act-plan-${index}`}>
          {t("story:storyboard.plan", {
            seconds: Math.round((plannedMs / 1000) * 10) / 10,
          })}
        </span>
        {!perShot && split && (
          <span
            className="story-clamp"
            data-testid={`story-act-split-${index}`}
            title={t("story:storyboard.splitHint", { max: ceiling })}
          >
            {t("story:storyboard.split", {
              count: pieces.length,
              max: ceiling,
            })}
          </span>
        )}
        {!perShot && adjusted && (
          <span
            className="story-clamp"
            data-testid={`story-act-clamp-${index}`}
            title={t("story:storyboard.clampHint", { max: ceiling })}
          >
            {t("story:storyboard.clamped", { seconds: askedSeconds })}
          </span>
        )}
        {/* How this act is filmed, where it parts from the telling's default:
            one act's card is where one act's way of filming belongs. */}
        <span
          aria-label={t("story:storyboard.actGranularity")}
          className="story-granularity story-act-granularity"
          role="radiogroup"
        >
          {GRANULARITY_OPTIONS.map((option) => (
            <button
              aria-checked={granularity === option}
              className={`story-choice${granularity === option ? " is-on" : ""}`}
              data-testid={`story-act-granularity-${option}-${index}`}
              key={option}
              onClick={() => chooseGranularity(option)}
              role="radio"
              type="button"
            >
              {t(`story:storyboard.granularity_${option}`)}
            </button>
          ))}
        </span>
        {/* Where the act stands in the episode, and how it leaves: the board
            is the reader's to reorder and to cut down, not only to fill in. */}
        <span className="story-act-tools">
          <button
            aria-label={t("story:storyboard.moveActUp", { name: act.title })}
            className="story-act-tool"
            data-testid={`story-act-up-${index}`}
            disabled={index === 0}
            onClick={() => move(-1)}
            title={t("story:storyboard.moveActUp", { name: act.title })}
            type="button"
          >
            ↑
          </button>
          <button
            aria-label={t("story:storyboard.moveActDown", { name: act.title })}
            className="story-act-tool"
            data-testid={`story-act-down-${index}`}
            disabled={last}
            onClick={() => move(1)}
            title={t("story:storyboard.moveActDown", { name: act.title })}
            type="button"
          >
            ↓
          </button>
          <button
            aria-label={t("story:storyboard.removeAct", { name: act.title })}
            className="story-act-tool is-remove"
            data-testid={`story-act-remove-${index}`}
            onClick={() => setRemoving(true)}
            title={t("story:storyboard.removeAct", { name: act.title })}
            type="button"
          >
            ✕
          </button>
        </span>
      </div>

      {/*
        What the act is waiting on, one bar per batch: a batch drawing its
        shots and one making its clip are two waits, and neither bar stands
        for the other.
      */}
      {runs.length > 0 && (
        <div className="story-runs">
          {runs.map(({ job, items }) => (
            <RunningBar
              job={job}
              key={job.id}
              label={t("story:jobs.generating")}
              pieces={items}
              testId="story-act-running"
            />
          ))}
        </div>
      )}

      <div className="story-refs-row">
        <RefPicker
          chosen={act.characterIds}
          elements={story.elements}
          kind="character"
          label={t("story:storyboard.characters")}
          many
          onInspect={(element) => setInspectingId(element.id)}
          onPick={(characterIds) => write({ characterIds })}
          pictureOf={(element) => takeFile(currentTake(element.main))}
        />
        <RefPicker
          chosen={act.sceneId === undefined ? [] : [act.sceneId]}
          elements={story.elements}
          kind="scene"
          label={t("story:storyboard.scene")}
          many={false}
          onInspect={(element) => setInspectingId(element.id)}
          onPick={(ids) => write({ sceneId: ids[0] ?? null })}
          pictureOf={(element) => takeFile(currentTake(element.main))}
        />
        <RefPicker
          chosen={act.propIds}
          elements={story.elements}
          kind="prop"
          label={t("story:storyboard.props")}
          many
          onInspect={(element) => setInspectingId(element.id)}
          onPick={(propIds) => write({ propIds })}
          pictureOf={(element) => takeFile(currentTake(element.main))}
        />
        <button
          className="link"
          data-testid={`story-act-new-ref-${index}`}
          disabled={story.elements.length >= MAX_ELEMENTS_PER_STORY}
          onClick={() => setAddingReference(true)}
          title={
            story.elements.length >= MAX_ELEMENTS_PER_STORY
              ? t("story:storyboard.elementLimit", {
                  max: MAX_ELEMENTS_PER_STORY,
                })
              : t("story:storyboard.newReferenceHint")
          }
          type="button"
        >
          {t("story:storyboard.newReference")}
        </button>
      </div>

      <label className="story-field-label" htmlFor={`act-summary-${index}`}>
        {t("story:storyboard.summary")}
      </label>
      <textarea
        aria-label={t("story:storyboard.summary")}
        className="story-act-summary"
        data-testid={`story-act-summary-${index}`}
        id={`act-summary-${index}`}
        maxLength={2000}
        onBlur={summary.commit}
        onChange={(event) => summary.set(event.target.value)}
        rows={3}
        value={summary.value}
      />

      <div className="story-act-sound">
        {SOUND_FIELDS.map((field) => (
          <label key={field.key}>
            <span className="story-field-label">
              {t(`story:storyboard.sound_${field.key}`)}
            </span>
            <input
              aria-label={t(`story:storyboard.sound_${field.key}`)}
              data-testid={`story-act-sound-${field.key}-${index}`}
              maxLength={200}
              onBlur={() => {
                if (sound[field.key] !== act.sound[field.key]) {
                  write({ sound });
                }
              }}
              onChange={(event) =>
                setSound({ ...sound, [field.key]: event.target.value })
              }
              value={sound[field.key]}
            />
          </label>
        ))}
      </div>

      <KeyframeTable
        act={act}
        busyClips={busyClips}
        busyKeyframes={busyKeyframes}
        busyLines={busyLines}
        chapterId={chapterId}
        guesses={guesses}
        story={story}
      />

      <div className="story-act-foot">
        <span className="story-hint" data-testid={`story-act-state-${index}`}>
          {t("story:storyboard.frames", {
            drawn,
            total: act.keyframes.length,
          })}
          {" · "}
          {perShot
            ? t("story:storyboard.shotsFilmed", {
                filmed,
                total: act.keyframes.length,
              })
            : clip === undefined
              ? t("story:storyboard.noClip")
              : t("story:storyboard.clipReady")}
        </span>

        {undrawn.length > 0 && (
          <span
            className="story-hint"
            data-testid={`story-act-missing-ref-${index}`}
            title={t("story:storyboard.undrawnHint")}
          >
            {undrawn.length < references.length
              ? t("story:storyboard.missingRef", {
                  names: undrawn.map((element) => element.name).join("、"),
                })
              : t("story:storyboard.noRefs")}
          </span>
        )}

        {drawable.length > 0 && (
          <button
            className="primary"
            data-testid={`story-act-draw-${index}`}
            disabled={act.keyframes.length === 0}
            onClick={drawMissing}
            title={
              act.keyframes.length === 0
                ? t("story:storyboard.noShots")
                : undefined
            }
            type="button"
          >
            {t("story:storyboard.drawMissing", { count: drawable.length })}
          </button>
        )}

        {!perShot && clip === undefined && (
          <button
            data-testid={`story-act-video-go-${index}`}
            disabled={!everyFrameDrawn || videoBusy}
            onClick={filmAct}
            title={
              everyFrameDrawn ? undefined : t("story:storyboard.drawEveryFrame")
            }
            type="button"
          >
            {videoBusy
              ? t("story:panels.drawing")
              : t("story:storyboard.filmAct")}
          </button>
        )}

        {clip !== undefined && (
          <span className="story-act-clip">
            <button
              aria-label={t("story:storyboard.playClip")}
              className="story-act-play"
              data-testid={`story-act-video-${index}`}
              onClick={() => setPlaying(true)}
              type="button"
            >
              <video
                muted
                preload="metadata"
                src={assetUrl(clip.assetIds[0])}
              />
            </button>
            {!perShot && (
              /*
                A clip already made is not the end of the ask that made it:
                the row that plays it keeps the ask beside it, so a take the
                reader does not like is asked over from where it stands.
              */
              <button
                className="link"
                data-testid={`story-act-video-again-${index}`}
                disabled={videoBusy}
                onClick={filmAct}
                type="button"
              >
                {videoBusy ? t("story:panels.drawing") : t("story:voice.again")}
              </button>
            )}
          </span>
        )}
      </div>

      {/*
        The sound of the act, under the pictures it belongs to: the lines read
        aloud in one voice, and the music they are spoken over. Both slots are
        optional, so the row says what a reader has not asked for yet and makes
        it one press away.
      */}
      <div className="story-sound-row" data-testid={`story-act-sound-${index}`}>
        <span className="story-field-label">{t("story:voice.rowLabel")}</span>
        <span className="story-sound-slot">
          {needing.length > 0 && (
            <button
              data-testid={`story-act-voice-go-${index}`}
              disabled={voiceBusy}
              onClick={speakAct}
              type="button"
            >
              {voiceBusy
                ? t("story:panels.drawing")
                : t("story:voice.speak", { count: needing.length })}
            </button>
          )}
          {needing.length === 0 && spoken > 0 && (
            <span
              className="story-hint"
              data-testid={`story-act-voice-count-${index}`}
            >
              {t("story:voice.allRead", { count: spoken })}
            </span>
          )}
          {spoken === 0 && (
            <span className="story-hint">{t("story:voice.noLines")}</span>
          )}
          {/*
            A reading of the whole act, made before every line had a voice of
            its own. Kept and playable — it is what the act sounds like until
            its lines are read one by one — and said to be what it is.
          */}
          {voice !== undefined && (
            <>
              <audio
                controls
                data-testid={`story-act-voice-${index}`}
                preload="metadata"
                src={assetUrl(voice.assetIds[0])}
              />
              <span className="story-hint">
                {t("story:voice.take", {
                  seconds: secondsOf(moka, voice.assetIds[0]),
                })}
                {" · "}
                {t("story:voice.legacyNote")}
              </span>
            </>
          )}
        </span>
        <span className="story-sound-slot">
          {music === undefined ? (
            <button
              data-testid={`story-act-music-go-${index}`}
              disabled={!hasSound || musicBusy}
              onClick={scoreAct}
              title={hasSound ? undefined : t("story:voice.noSound")}
              type="button"
            >
              {musicBusy ? t("story:panels.drawing") : t("story:voice.score")}
            </button>
          ) : (
            <>
              <audio
                controls
                data-testid={`story-act-music-${index}`}
                preload="metadata"
                src={assetUrl(music.assetIds[0])}
              />
              <span className="story-hint">
                {t("story:voice.take", {
                  seconds: secondsOf(moka, music.assetIds[0]),
                })}
              </span>
              <button
                className="link"
                data-testid={`story-act-music-again-${index}`}
                disabled={musicBusy}
                onClick={scoreAct}
                type="button"
              >
                {t("story:voice.again")}
              </button>
            </>
          )}
        </span>
      </div>

      {addingReference && (
        <ElementDraftDialog
          confirm={t("story:elements.newReferenceConfirm")}
          note={t("story:elements.newReferenceNote")}
          onAdd={(draft) => {
            setAddingReference(false);
            addReference(draft);
          }}
          onCancel={() => setAddingReference(false)}
          title={t("story:elements.newReferenceTitle")}
        />
      )}

      {inspecting !== null && (
        <ElementPictureInspector
          element={inspecting}
          onClose={() => setInspectingId(null)}
          story={story}
        />
      )}

      {playing && clip !== undefined && (
        <StoryLightbox
          assetIds={clip.assetIds}
          label={t("story:storyboard.playClip")}
          onClose={() => setPlaying(false)}
          video
        />
      )}

      {granularityTo !== null && (
        <ConfirmDialog
          body={t("story:storyboard.granularityBody", {
            count: actVideos,
            to: t(`story:storyboard.granularity_by_${granularityTo}`),
          })}
          confirm={t("story:storyboard.granularityConfirm", {
            to: t(`story:storyboard.granularity_by_${granularityTo}`),
          })}
          note={t("story:storyboard.granularityNote")}
          onCancel={() => setGranularityTo(null)}
          onConfirm={() => {
            writeGranularity(granularityTo);
            setGranularityTo(null);
          }}
          testId={`change-act-granularity-${index}`}
          title={t("story:storyboard.granularityTitle", {
            to: t(`story:storyboard.granularity_by_${granularityTo}`),
          })}
        />
      )}

      {removing && (
        <ConfirmDialog
          body={t("story:storyboard.removeActBody", {
            name: act.title,
            count: act.keyframes.length,
          })}
          confirm={t("story:storyboard.removeActConfirm")}
          note={t("story:storyboard.removeActNote")}
          onCancel={() => setRemoving(false)}
          onConfirm={() => {
            setRemoving(false);
            removeAct();
          }}
          testId="remove-act"
          title={t("story:storyboard.removeActTitle", { name: act.title })}
        />
      )}
    </li>
  );
}

/** The three parts of an act's sound, in the order they are written. */
const SOUND_FIELDS: Array<{ key: keyof StoryActSound }> = [
  { key: "music" },
  { key: "sfx" },
  { key: "ambience" },
];

/**
 * One act's field, as the reader leaves it.
 */
function writeAct(
  story: StoryDocument,
  chapterId: string,
  act: StoryAct,
  patch: StoryActPatch,
): void {
  execute(i18n.t("story:history.storyboard"), [
    {
      type: "updateStoryAct",
      storyId: story.id,
      chapterId,
      actId: act.id,
      patch,
    },
  ]);
}
