import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  CAMERA_ANGLE_LABELS,
  CAMERA_MOVE_LABELS,
  FILM_ROLE_LABELS,
  SHOT_SIZE_LABELS,
  STORY_CAMERA_ANGLES,
  STORY_CAMERA_MOVES,
  STORY_FILM_ROLES,
  STORY_SHOT_SIZES,
  actCast,
  createKeyframe,
  currentTake,
  keyframeAt,
  newId,
  slotWithoutTake,
  slotWithCurrent,
  storyMentions,
  voiceTakeOf,
  type StoryGuess,
} from "../../../shared/domain";
import type {
  StoryAct,
  StoryDialogueLine,
  StoryDocument,
  StoryElement,
  StoryFilmRole,
  MokaFile,
  StoryKeyframe,
  StoryKeyframePatch,
  StorySlot,
  StoryVoiceTake,
} from "../../../shared/domain/types";
import { assetThumbUrl, assetUrl } from "../../../api/assets";
import { findResource } from "../../../shared/domain/validate";
import { i18n } from "../../../shared/i18n";
import { storyKeyframePromptParts } from "../../../shared/prompts";
import { execute } from "../../editor/commands/execute";
import { planAssembly } from "../assembly";
import { planDubbing, type DubCue } from "../dubbing";
import {
  drawnFrames,
  filmRoleOf,
  keyframeCast,
  planKeyframeArt,
  planKeyframeVideos,
  settledRoleFrames,
} from "../jobs/plan";
import { useProjectStore } from "../../editor/stores/projectStore";
import { planLineVoiceAsks } from "../jobs/plan";
import { useStoryRun, useStoryWavesRun } from "../stores/storyJobStore";
import { secondsOf } from "./takes";
import { KeyframeContentField, type MentionKind } from "./KeyframeContentField";
import { frameRatio } from "./ratios";
import { liveStory, removeOldTake, type TakeDrop } from "./removeOldTake";
import { StoryLightbox } from "./StoryLightbox";
import { StorySlotView } from "./StorySlotView";
import { useField } from "./useField";

/** How wide the little references beside a frame's ask are asked for: they are
    drawn 44 px square, and the lightbox shows the file itself. */
const REF_THUMB_WIDTH = 128;
import { moved, writeKeyframes } from "./writeBoard";

/** The longest and shortest a shot may be, in seconds. */
const SHOT_MIN_S = 0.4;
const SHOT_MAX_S = 60;

/**
 * One act's shots, as the table a board is: framing, movement, what is shown,
 * what is said, how long it runs, and the frame drawn for it.
 *
 * The table is the reader's to write in for as long as the telling is being
 * worked on: nothing here is sealed once the pictures have been asked for, so
 * a shot discovered to be framed wrongly is corrected where it stands — and
 * the frames and the clips are made again from what it says now.
 *
 * The table is only how a board is read and edited: what a cell writes goes
 * through the command pipeline like everything else, so a shot that was
 * mis-typed is undone rather than argued with.
 */
export function KeyframeTable({
  story,
  chapterId,
  act,
  guesses,
  busyKeyframes,
  busyClips,
  busyLines,
}: {
  story: StoryDocument;
  chapterId: string;
  act: StoryAct;
  /** The cells whose framing the reading chose rather than read. */
  guesses: StoryGuess[];
  /** The shots being drawn just now, by the place's own name. */
  busyKeyframes: Set<string>;
  /** The shots being filmed just now, by the place's own name. */
  busyClips: Set<string>;
  /** The lines being read just now, by the line's own name. */
  busyLines: Set<string>;
}) {
  const { t } = useTranslation();
  const [dialogueAt, setDialogueAt] = useState<string | null>(null);
  const perShot = story.shotGranularity === "keyframe";
  // The last drawn frame cannot open a pair — nothing is drawn after it — and
  // the act's own closing frame, when the pair before it takes it, is not the
  // reader's to give a role at all.
  const drawn = drawnFrames(act);
  const lastDrawn = drawn.length === 0 ? undefined : drawn[drawn.length - 1].id;
  const settled = settledRoleFrames(act);

  const addShot = () => {
    writeKeyframes(story, chapterId, act, [
      ...act.keyframes,
      createKeyframe(act.keyframes.length),
    ]);
  };

  return (
    <div className="story-table-wrap">
      <table className="story-table" data-testid="story-table">
        <thead>
          <tr>
            <th className="story-col-index">#</th>
            <th>{t("story:storyboard.shotSize")}</th>
            <th>{t("story:storyboard.cameraMove")}</th>
            <th>{t("story:storyboard.angle")}</th>
            <th>{t("story:storyboard.content")}</th>
            <th>{t("story:storyboard.dialogue")}</th>
            <th>{t("story:storyboard.duration")}</th>
            <th>{t("story:storyboard.frame")}</th>
            {perShot && <th>{t("story:storyboard.clip")}</th>}
            <th>{t("story:storyboard.rowActions")}</th>
          </tr>
        </thead>
        <tbody>
          {act.keyframes.map((keyframe, index) => (
            <KeyframeRow
              act={act}
              busy={busyKeyframes.has(keyframe.id)}
              busyLines={busyLines}
              clipBusy={busyClips.has(keyframe.id)}
              chapterId={chapterId}
              dialogueOpen={dialogueAt === keyframe.id}
              guesses={guesses.filter((guess) => guess.keyframe === index + 1)}
              index={index}
              key={keyframe.id}
              keyframe={keyframe}
              onDialogue={() =>
                setDialogueAt(dialogueAt === keyframe.id ? null : keyframe.id)
              }
              perShot={perShot}
              roleLocked={settled.has(keyframe.id)}
              rolePairable={keyframe.id !== lastDrawn}
              story={story}
            />
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={perShot ? 10 : 9}>
              <button
                className="link"
                data-testid="story-kf-add"
                onClick={addShot}
                type="button"
              >
                {t("story:storyboard.addShot")}
              </button>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/**
 * How a drawn frame is used when the act is shot.
 *
 * Offered beside the picture it belongs to, and only while the story is
 * boarded an act at a time: a shot made into its own clip is filmed from its
 * own frame whatever any role says, so the pick has nothing to decide there.
 * A role the reader gave before the board moved on — a pair whose frame after
 * it was taken away — is kept on show as a disabled word rather than quietly
 * rewritten, since what the act does with the frame is not what the frame says.
 */
function FilmRoleSelect({
  role,
  index,
  locked,
  pairable,
  onWrite,
}: {
  role: StoryFilmRole;
  index: number;
  /** Whether the act closes on this frame's pair, taking its role away. */
  locked: boolean;
  /** Whether pairing with the frame after it is still on offer. */
  pairable: boolean;
  onWrite: (role: StoryFilmRole) => void;
}) {
  const { t } = useTranslation();
  const cell = t("story:storyboard.cell", {
    at: index + 1,
    name: t("story:storyboard.filmRole"),
  });
  return (
    <select
      aria-label={cell}
      className="story-kf-role"
      data-testid={`story-kf-role-${index}`}
      disabled={locked}
      onChange={(event) => onWrite(event.target.value as StoryFilmRole)}
      title={
        locked
          ? t("story:storyboard.filmRoleSettled")
          : t("story:storyboard.filmRoleHint")
      }
      value={role}
    >
      {STORY_FILM_ROLES.filter(
        (each) => each !== "firstLastFrame" || pairable,
      ).map((each) => (
        <option key={each} value={each}>
          {t(FILM_ROLE_LABELS[each])}
        </option>
      ))}
      {!pairable && role === "firstLastFrame" && (
        <option disabled value="firstLastFrame">
          {t(FILM_ROLE_LABELS.firstLastFrame)}
        </option>
      )}
    </select>
  );
}

/** One shot of the table, and the row the lines of its dialogue are edited in. */
function KeyframeRow({
  story,
  chapterId,
  act,
  keyframe,
  index,
  guesses,
  perShot,
  roleLocked,
  rolePairable,
  busy,
  busyLines,
  clipBusy,
  dialogueOpen,
  onDialogue,
}: {
  story: StoryDocument;
  chapterId: string;
  act: StoryAct;
  keyframe: StoryKeyframe;
  index: number;
  guesses: StoryGuess[];
  perShot: boolean;
  /** Whether the act closes on this frame's pair, taking its role away. */
  roleLocked: boolean;
  /** Whether pairing with the frame after it is still on offer. */
  rolePairable: boolean;
  busy: boolean;
  /** The lines of this act being read just now, by the line's own name. */
  busyLines: Set<string>;
  /** Whether this shot's own clip is being made just now. */
  clipBusy: boolean;
  dialogueOpen: boolean;
  onDialogue: () => void;
}) {
  const { t } = useTranslation();
  const run = useStoryRun();
  const at = index + 1;
  const cell = (name: string) => t("story:storyboard.cell", { at, name });
  const clip = currentTake(keyframe.video);
  const given = (field: StoryGuess["field"]) =>
    guesses.find((guess) => guess.field === field);

  const write = (patch: StoryKeyframePatch) =>
    writeKeyframe(story, chapterId, act, keyframe.id, patch);

  const draw = () => {
    const [item] = planKeyframeArt(story, [
      { chapterId, actId: act.id, keyframeId: keyframe.id },
    ]);
    if (item !== undefined) void run(story.id, "keyframeArt", [item]);
  };

  const film = () => {
    const [item] = planKeyframeVideos(story, chapterId, act.id, [keyframe.id]);
    if (item !== undefined) void run(story.id, "keyframeVideo", [item]);
  };

  const remove = () =>
    writeKeyframes(
      story,
      chapterId,
      act,
      act.keyframes.filter((each) => each.id !== keyframe.id),
    );

  // A shot discovered to be in the wrong place is moved rather than written
  // again: the row keeps everything that makes it this shot — its words, its
  // picture, its clip — and only the place in the list changes.
  const insertAbove = () => {
    const next = [...act.keyframes];
    next.splice(index, 0, createKeyframe(index));
    writeKeyframes(story, chapterId, act, next);
  };
  const move = (by: number) => {
    const to = index + by;
    if (to < 0 || to >= act.keyframes.length) return;
    writeKeyframes(story, chapterId, act, moved(act.keyframes, index, to));
  };
  const first = index === 0;
  const last = index === act.keyframes.length - 1;

  // A shot is filmed from its own picture: what a clip of a shot nobody has
  // drawn would be made from is the words alone, which is not what the board
  // says the shot looks like.
  const filmed = keyframe.art.takes.length > 0;

  return (
    <>
      <tr data-testid={`story-kf-${index}`}>
        <td className="story-col-index">
          {/*
            A shot is inserted where the reader is looking rather than only at
            the end of the list: the button stands in the row it would go above,
            so a board being reworked grows where the work is.
          */}
          <button
            aria-label={cell(t("story:storyboard.insertShot"))}
            className="story-kf-insert"
            data-testid={`story-kf-insert-${index}`}
            onClick={insertAbove}
            title={t("story:storyboard.insertShotHere")}
            type="button"
          >
            ＋
          </button>
          <span className="story-kf-number">{at}</span>
        </td>
        <Cell guessed={given("shotSize")} index={index} testId="size">
          <select
            aria-label={cell(t("story:storyboard.shotSize"))}
            data-testid={`story-kf-size-${index}`}
            onChange={(event) =>
              write({
                shotSize: event.target.value as StoryKeyframe["shotSize"],
              })
            }
            value={keyframe.shotSize}
          >
            {STORY_SHOT_SIZES.map((each) => (
              <option key={each} value={each}>
                {t(SHOT_SIZE_LABELS[each])}
              </option>
            ))}
          </select>
        </Cell>
        <Cell guessed={given("cameraMove")} index={index} testId="move">
          <select
            aria-label={cell(t("story:storyboard.cameraMove"))}
            data-testid={`story-kf-move-${index}`}
            onChange={(event) =>
              write({
                cameraMove: event.target.value as StoryKeyframe["cameraMove"],
              })
            }
            value={keyframe.cameraMove}
          >
            {STORY_CAMERA_MOVES.map((each) => (
              <option key={each} value={each}>
                {t(CAMERA_MOVE_LABELS[each])}
              </option>
            ))}
          </select>
        </Cell>
        <Cell guessed={given("angle")} index={index} testId="angle">
          <select
            aria-label={cell(t("story:storyboard.angle"))}
            data-testid={`story-kf-angle-${index}`}
            onChange={(event) =>
              write({ angle: event.target.value as StoryKeyframe["angle"] })
            }
            value={keyframe.angle}
          >
            {STORY_CAMERA_ANGLES.map((each) => (
              <option key={each} value={each}>
                {t(CAMERA_ANGLE_LABELS[each])}
              </option>
            ))}
          </select>
        </Cell>
        <td className="story-col-content">
          <KeyframePromptCell
            act={act}
            chapterId={chapterId}
            index={index}
            keyframe={keyframe}
            story={story}
            write={write}
          />
        </td>
        <td>
          <button
            aria-expanded={dialogueOpen}
            aria-label={cell(t("story:storyboard.dialogue"))}
            className="story-dialogue-toggle"
            data-testid={`story-kf-dialogue-${index}`}
            onClick={onDialogue}
            type="button"
          >
            {keyframe.dialogue.length === 0
              ? t("story:storyboard.noLines")
              : t("story:storyboard.lines", {
                  count: keyframe.dialogue.length,
                })}
          </button>
        </td>
        <td>
          <input
            aria-label={cell(t("story:storyboard.duration"))}
            className="story-kf-seconds"
            data-testid={`story-kf-seconds-${index}`}
            max={SHOT_MAX_S}
            min={SHOT_MIN_S}
            onChange={(event) => {
              const seconds = Number(event.target.value);
              if (!Number.isFinite(seconds)) return;
              const ms = Math.round(
                Math.min(SHOT_MAX_S, Math.max(SHOT_MIN_S, seconds)) * 1000,
              );
              write({ durationMs: ms });
            }}
            step={0.1}
            type="number"
            value={Math.round((keyframe.durationMs / 1000) * 10) / 10}
          />
        </td>
        <td className="story-col-frame">
          <StorySlotView
            actions={
              perShot ? undefined : (
                <FilmRoleSelect
                  index={index}
                  locked={roleLocked}
                  onWrite={(role) => write({ filmRole: role })}
                  pairable={rolePairable}
                  role={filmRoleOf(keyframe)}
                />
              )
            }
            busy={busy}
            canGenerate
            label={t("story:storyboard.frame")}
            onChoose={(assetId) =>
              keepFrame(story, chapterId, act, keyframe, assetId)
            }
            onGenerate={draw}
            onRemove={(assetId) =>
              removeOldTake(assetId, () =>
                dropFrame(story, chapterId, act, keyframe, assetId),
              )
            }
            ratio={frameRatio(story)}
            slot={keyframe.art}
            testId={`story-kf-slot-${index}`}
          />
        </td>
        {perShot && (
          <td>
            {clip === undefined ? (
              <button
                className="link"
                data-testid={`story-kf-video-${index}`}
                disabled={!filmed || clipBusy}
                onClick={film}
                title={
                  filmed ? undefined : t("story:storyboard.drawFrameFirst")
                }
                type="button"
              >
                {clipBusy
                  ? t("story:panels.drawing")
                  : t("story:storyboard.film")}
              </button>
            ) : (
              <span className="story-kf-clip">
                <video
                  muted
                  preload="metadata"
                  src={assetUrl(clip.assetIds[0])}
                />
                {/*
                  The shot is filmed once, but not only once: a take the reader
                  does not like is asked over from the row that holds it.
                */}
                <button
                  className="link"
                  data-testid={`story-kf-video-again-${index}`}
                  disabled={clipBusy}
                  onClick={film}
                  type="button"
                >
                  {clipBusy
                    ? t("story:panels.drawing")
                    : t("story:voice.again")}
                </button>
              </span>
            )}
          </td>
        )}
        <td>
          <span className="story-kf-tools">
            <button
              aria-label={cell(t("story:storyboard.moveShotUp"))}
              className="story-kf-move"
              data-testid={`story-kf-up-${index}`}
              disabled={first}
              onClick={() => move(-1)}
              title={t("story:storyboard.moveShotUp")}
              type="button"
            >
              ↑
            </button>
            <button
              aria-label={cell(t("story:storyboard.moveShotDown"))}
              className="story-kf-move"
              data-testid={`story-kf-down-${index}`}
              disabled={last}
              onClick={() => move(1)}
              title={t("story:storyboard.moveShotDown")}
              type="button"
            >
              ↓
            </button>
            <button
              aria-label={cell(t("story:storyboard.removeShot"))}
              className="story-kf-remove"
              data-testid={`story-kf-remove-${index}`}
              onClick={remove}
              type="button"
            >
              ✕
            </button>
          </span>
        </td>
      </tr>
      {dialogueOpen && (
        <tr className="story-dialogue-row">
          <td colSpan={perShot ? 10 : 9}>
            <DialogueEditor
              act={act}
              busyLines={busyLines}
              chapterId={chapterId}
              characters={actCast(story, act).characters}
              keyframe={keyframe}
              lines={keyframe.dialogue}
              onDone={(dialogue) => {
                onDialogue();
                write({ dialogue });
              }}
              story={story}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The 画面内容 cell: the ask exactly as it will be made, with the shot's own
 * words edited in place and the pictures they name beneath them.
 *
 * The template's sentences stand around the words as the muted scaffolding
 * they are, and the words between them are the only part a reader owns. Every
 * `name` mention in them is a picture the ask travels with, in the order the
 * names first appear, so what is read here is what the model is sent — and the
 * thumbnails under it are the pictures that ride along: the ones the story's
 * limit left behind stand dimmed among them.
 */
function KeyframePromptCell({
  story,
  chapterId,
  act,
  keyframe,
  index,
  write,
}: {
  story: StoryDocument;
  chapterId: string;
  act: StoryAct;
  keyframe: StoryKeyframe;
  index: number;
  write: (patch: StoryKeyframePatch) => void;
}) {
  const { t } = useTranslation();
  const [zoomed, setZoomed] = useState<{
    assetIds: string[];
    label: string;
  } | null>(null);
  const content = useField(keyframe.content, (value) => {
    if (value !== keyframe.content) write({ content: value });
  });
  const chapterTitle =
    story.chapters.find((held) => held.id === chapterId)?.title ?? "";
  const cast = keyframeCast(story, content.value);
  // The same words the plan will send, read apart: the fixed scaffolding is
  // the muted part, and the hole it was written around is the field below.
  const parts = storyKeyframePromptParts({
    aspect: story.brief.aspect,
    style: story.brief.style,
    chapter: { title: chapterTitle },
    act: { summary: act.summary },
    keyframe: {
      content: content.value,
      shotSize: keyframe.shotSize,
      cameraMove: keyframe.cameraMove,
      angle: keyframe.angle,
    },
    cast: cast.carried.map(({ element }) => ({
      name: element.name,
      description: element.description,
    })),
  });

  return (
    <>
      <div className="story-prompt" data-testid={`story-kf-prompt-${index}`}>
        <span className="story-prompt-scaffold">{parts.before}</span>
        <KeyframeContentField
          kinds={mentionKinds(story, cast, content.value)}
          label={t("story:storyboard.content")}
          onChange={content.set}
          onCommit={content.commit}
          testId={`story-kf-content-${index}`}
          value={content.value}
        />
        <span className="story-prompt-scaffold">{parts.after}</span>
      </div>
      {(cast.carried.length > 0 || cast.beyond.length > 0) && (
        <div className="story-ref-strip" data-testid={`story-kf-refs-${index}`}>
          {cast.carried.map(({ element, assetId }, at) => (
            <button
              aria-label={t("story:storyboard.enlargeRef", {
                name: element.name,
              })}
              className="story-ref-thumb"
              data-testid={`story-kf-ref-${index}-${at}`}
              key={element.id}
              onClick={() =>
                setZoomed({ assetIds: [assetId], label: element.name })
              }
              title={t("story:storyboard.mentionCarried", {
                name: element.name,
              })}
              type="button"
            >
              <img
                alt={element.name}
                src={assetThumbUrl(assetId, REF_THUMB_WIDTH)}
              />
            </button>
          ))}
          {cast.beyond.map(({ element, assetId }, at) => (
            <button
              aria-label={t("story:storyboard.notCarried", {
                name: element.name,
              })}
              className="story-ref-thumb is-beyond"
              data-testid={`story-kf-ref-beyond-${index}-${at}`}
              key={element.id}
              onClick={() =>
                setZoomed({ assetIds: [assetId], label: element.name })
              }
              title={t("story:storyboard.notCarried", { name: element.name })}
              type="button"
            >
              <img
                alt={element.name}
                src={assetThumbUrl(assetId, REF_THUMB_WIDTH)}
              />
            </button>
          ))}
        </div>
      )}
      {zoomed !== null && (
        <StoryLightbox
          assetIds={zoomed.assetIds}
          label={zoomed.label}
          onClose={() => setZoomed(null)}
        />
      )}
    </>
  );
}

/** How each name the words mention stands in this frame's ask. */
function mentionKinds(
  story: StoryDocument,
  cast: ReturnType<typeof keyframeCast>,
  content: string,
): Record<string, MentionKind> {
  const carried = new Set(cast.carried.map(({ element }) => element.name));
  const beyond = new Set(cast.beyond.map(({ element }) => element.name));
  const known = new Set(story.elements.map((element) => element.name));
  const kinds: Record<string, MentionKind> = {};
  for (const { name } of storyMentions(content)) {
    if (kinds[name] !== undefined) continue;
    if (carried.has(name)) kinds[name] = "carried";
    else if (beyond.has(name)) kinds[name] = "beyond";
    else if (known.has(name)) kinds[name] = "undrawn";
    else kinds[name] = "unknown";
  }
  return kinds;
}

/**
 * One cell of the table, with the mark that says the parser chose its value.
 *
 * A shot framed as something nobody offered is a shot whose framing is the
 * parser's word rather than the telling's, and the reader can only see that if
 * the cell says so — the answer's own words are in the mark's title.
 */
function Cell({
  children,
  guessed,
  index,
  testId,
}: {
  children: React.ReactNode;
  guessed: StoryGuess | undefined;
  index: number;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <td>
      {children}
      {guessed !== undefined && (
        <span
          aria-label={t("story:storyboard.guessed", { from: guessed.from })}
          className="story-guessed"
          data-testid={`story-guessed-${testId}-${index}`}
          title={t("story:storyboard.guessed", { from: guessed.from })}
        >
          ●
        </span>
      )}
    </td>
  );
}

/**
 * The lines a shot is said in, as a list the reader edits.
 *
 * The lines are held here while the editor is open and written when it is
 * closed, so editing four lines of a shot is one step of the history rather
 * than one per keystroke.
 */
/**
 * Who says a line: a character of this act, or somebody the cast has not got.
 *
 * A line's picture and its voice are both found by the character, so the act's
 * cast is a list to pick from rather than a name to type — and a name typed
 * anyway is read against the cast as it is typed, so a line written before its
 * character had a card still finds one. Choosing the off-screen option keeps
 * whatever name is written there: a line nobody in the cast says is read in
 * the telling's own voice.
 */
function SpeakerField({
  characters,
  index,
  line,
  onWrite,
}: {
  /** The act's characters, still in the story. */
  characters: StoryElement[];
  index: number;
  line: StoryDialogueLine;
  onWrite: (patch: Partial<StoryDialogueLine>) => void;
}) {
  const { t } = useTranslation();
  const chosen = characters.find((element) => element.id === line.characterId);

  return (
    <>
      <select
        aria-label={t("story:storyboard.speakerRole")}
        className="story-line-role"
        data-testid={`story-line-role-${index}`}
        onChange={(event) => {
          const element = characters.find(
            (held) => held.id === event.target.value,
          );
          onWrite(
            element === undefined
              ? { characterId: undefined }
              : { characterId: element.id, speaker: element.name },
          );
        }}
        value={chosen?.id ?? ""}
      >
        <option value="">{t("story:storyboard.offScreen")}</option>
        {characters.map((element) => (
          <option key={element.id} value={element.id}>
            {element.name}
          </option>
        ))}
      </select>
      <input
        aria-label={t("story:storyboard.speakerName")}
        data-testid={`story-line-speaker-${index}`}
        maxLength={40}
        onChange={(event) => {
          const name = event.target.value;
          const matched = characters.find((held) => held.name === name.trim());
          onWrite({ speaker: name, characterId: matched?.id });
        }}
        placeholder={t("story:storyboard.offScreen")}
        value={line.speaker}
      />
    </>
  );
}

/**
 * What has become of one line's reading, and the way to make another.
 *
 * A line read before it was rewritten says so rather than passing the older
 * words off as the ones standing here, and a line with a take is playable
 * where it lies: what was said is worth hearing before asking again. The ask
 * is the line's own, and the button is held while the editor's words are
 * unwritten — a reading is planned from the document, and a draft is not one.
 */
function LineVoiceRow({
  index,
  take,
  sentence,
  cue,
  busy,
  dirty,
  moka,
  onAsk,
}: {
  index: number;
  take: StoryVoiceTake | undefined;
  /** The line as the document holds it, which the take is read against. */
  sentence: StoryDialogueLine;
  /** How this line's reading will lie under its shot, where it is planned. */
  cue: DubCue | undefined;
  busy: boolean;
  /** Whether the editor's words are not the document's yet. */
  dirty: boolean;
  moka: MokaFile | null;
  onAsk: () => void;
}) {
  const { t } = useTranslation();
  const assetId = take?.slot.takes.at(-1)?.assetIds[0];
  const stale = take !== undefined && take.text !== sentence.text.trim();
  return (
    <div className="story-line-voice" data-testid={`story-line-voice-${index}`}>
      <span
        className="story-hint"
        data-testid={`story-line-voice-state-${index}`}
      >
        {take === undefined
          ? t("story:voice.unspent")
          : stale
            ? t("story:voice.stale")
            : take.voice === ""
              ? t("story:voice.spent", {
                  seconds:
                    assetId === undefined ? "—" : secondsOf(moka, assetId),
                })
              : t("story:voice.spentIn", {
                  seconds:
                    assetId === undefined ? "—" : secondsOf(moka, assetId),
                  voice: take.voice,
                })}
      </span>
      {assetId !== undefined && (
        <audio
          controls
          data-testid={`story-line-voice-take-${index}`}
          preload="metadata"
          src={assetUrl(assetId)}
        />
      )}
      {/* What the reading costs where it will lie, so that the reader can
          shorten the words or lengthen the shot before paying for a cut. */}
      {cue !== undefined && cue.fit !== "natural" && (
        <span
          className="story-hint"
          data-testid={`story-line-voice-fit-${index}`}
        >
          {fitsLine(cue)}
        </span>
      )}
      <button
        className="link"
        data-testid={`story-line-voice-go-${index}`}
        disabled={busy || dirty}
        onClick={onAsk}
        title={dirty ? t("story:voice.saveFirst") : undefined}
        type="button"
      >
        {busy
          ? t("story:panels.drawing")
          : take === undefined
            ? t("story:voice.lineAsk")
            : t("story:voice.again")}
      </button>
    </div>
  );
}

/** How a reading lies in its shot, in the reader's language. */
function fitsLine(cue: DubCue): string {
  if (cue.fit === "unmeasured") return i18n.t("story:voice.fitsUnmeasured");
  const over = (((cue.materialMs ?? 0) - cue.windowMs) / 1000).toFixed(1);
  if (cue.fit === "sped") {
    return i18n.t("story:voice.fitsSped", {
      over,
      speed: cue.speed.toFixed(2),
    });
  }
  return i18n.t("story:voice.fitsOverrun", {
    over,
    spill: ((cue.durationMs - cue.windowMs) / 1000).toFixed(1),
  });
}

/**
 * One line as an edit leaves it.
 *
 * A field the edit clears is taken off the line rather than left holding
 * nothing: a line with no character is a line nobody in the cast says, which
 * is what the document should say about it.
 */
function editedLine(
  line: StoryDialogueLine,
  patch: Partial<StoryDialogueLine>,
): StoryDialogueLine {
  const next = { ...line, ...patch };
  return {
    id: next.id,
    speaker: next.speaker,
    text: next.text,
    ...(next.characterId !== undefined
      ? { characterId: next.characterId }
      : {}),
    ...(next.tone !== undefined ? { tone: next.tone } : {}),
  };
}

function DialogueEditor({
  story,
  chapterId,
  act,
  keyframe,
  busyLines,
  lines,
  characters,
  onDone,
}: {
  story: StoryDocument;
  chapterId: string;
  act: StoryAct;
  keyframe: StoryKeyframe;
  /** The lines of this act being read just now, by the line's own name. */
  busyLines: Set<string>;
  lines: StoryDialogueLine[];
  /** The act's characters, still in the story: who a line may be given to. */
  characters: StoryElement[];
  onDone: (lines: StoryDialogueLine[]) => void;
}) {
  const { t } = useTranslation();
  const runWaves = useStoryWavesRun();
  const moka = useProjectStore((state) => state.moka);
  const [draft, setDraft] = useState(lines);
  // Where the readings that exist will lie under their shots, planned from the
  // telling as it stands: a line about to be read is told what it will cost.
  const cues =
    moka === null
      ? undefined
      : new Map(
          planDubbing(
            story,
            planAssembly(story, moka).units,
            (assetId) => findResource(moka, assetId)?.probe?.durationMs,
          ).cues.map((cue) => [cue.lineId, cue]),
        );
  const write = (at: number, patch: Partial<StoryDialogueLine>) =>
    setDraft(
      draft.map((held, index) =>
        index === at ? editedLine(held, patch) : held,
      ),
    );
  /** Reads one line on its own, in the voice its speaker is given. */
  const ask = (lineId: string) =>
    void runWaves(
      story.id,
      "voice",
      planLineVoiceAsks(story, chapterId, act.id, [lineId]),
    );

  return (
    <div className="story-dialogue" data-testid="story-dialogue">
      {draft.length === 0 && (
        <p className="story-hint">{t("story:storyboard.noDialogue")}</p>
      )}
      {draft.map((line, index) => {
        // What the document holds of this line, which is what a take belongs
        // to: a line added in the open editor is not in the story yet, and has
        // nothing read for it to show.
        const saved = keyframe.dialogue.find((held) => held.id === line.id);
        return (
          <div className="story-dialogue-line" key={line.id}>
            <div className="story-dialogue-fields">
              <SpeakerField
                characters={characters}
                index={index}
                line={line}
                onWrite={(patch) => write(index, patch)}
              />
              <input
                aria-label={t("story:storyboard.line")}
                data-testid={`story-line-text-${index}`}
                maxLength={500}
                onChange={(event) => write(index, { text: event.target.value })}
                value={line.text}
              />
              <input
                aria-label={t("story:storyboard.tone")}
                data-testid={`story-line-tone-${index}`}
                maxLength={60}
                onChange={(event) => write(index, { tone: event.target.value })}
                value={line.tone ?? ""}
              />
              <button
                aria-label={t("story:storyboard.removeLine")}
                className="link"
                data-testid={`story-line-remove-${index}`}
                onClick={() =>
                  setDraft(draft.filter((_held, at) => at !== index))
                }
                type="button"
              >
                ✕
              </button>
            </div>
            {saved !== undefined && (
              <LineVoiceRow
                busy={busyLines.has(line.id)}
                cue={cues?.get(line.id)}
                dirty={line.text.trim() !== saved.text.trim()}
                index={index}
                moka={moka}
                onAsk={() => ask(line.id)}
                sentence={saved}
                take={voiceTakeOf(keyframe, line.id)}
              />
            )}
          </div>
        );
      })}
      <div className="story-step-actions">
        <button
          className="link"
          data-testid="story-line-add"
          onClick={() =>
            setDraft([...draft, { id: newId(), speaker: "", text: "" }])
          }
          type="button"
        >
          {t("story:storyboard.addLine")}
        </button>
        <button
          className="primary"
          data-testid="story-line-done"
          onClick={() => onDone(draft)}
          type="button"
        >
          {t("story:storyboard.linesDone")}
        </button>
      </div>
    </div>
  );
}

/** A shot's words, written as one step of the history. */
function writeKeyframe(
  story: StoryDocument,
  chapterId: string,
  act: StoryAct,
  keyframeId: string,
  patch: StoryKeyframePatch,
): void {
  execute(i18n.t("story:history.storyboard"), [
    {
      type: "updateStoryKeyframe",
      storyId: story.id,
      chapterId,
      actId: act.id,
      keyframeId,
      patch,
    },
  ]);
}

/** One shot's frame, whole, as the reader leaves it. */
function writeFrame(
  story: StoryDocument,
  chapterId: string,
  act: StoryAct,
  keyframe: StoryKeyframe,
  slot: StorySlot,
) {
  return execute(i18n.t("story:history.storyboard"), [
    {
      type: "setStorySlot",
      storyId: story.id,
      target: {
        kind: "keyframe",
        chapterId,
        actId: act.id,
        keyframeId: keyframe.id,
      },
      slot,
    },
  ]);
}

/**
 * One shot's old drawing dropped from its place, as the live document holds
 * that place: a slot is written whole, so a slot read off the table's render
 * would put back whatever a job landed while the picks dialog stood open.
 */
function dropFrame(
  story: StoryDocument,
  chapterId: string,
  act: StoryAct,
  keyframe: StoryKeyframe,
  assetId: string,
): TakeDrop {
  const live = liveStory(story.id);
  const frame =
    live === undefined
      ? undefined
      : keyframeAt(live, {
          chapterId,
          actId: act.id,
          keyframeId: keyframe.id,
        });
  if (live === undefined || frame === undefined) return "gone";
  const without = slotWithoutTake(frame.art, assetId);
  if (without === frame.art) return "gone";
  return writeFrame(live, chapterId, act, frame, without) === null
    ? "refused"
    : "dropped";
}

/** Keeps the frame a reader picked, letting the older ones go on being there. */
function keepFrame(
  story: StoryDocument,
  chapterId: string,
  act: StoryAct,
  keyframe: StoryKeyframe,
  assetId: string,
): void {
  writeFrame(
    story,
    chapterId,
    act,
    keyframe,
    slotWithCurrent(keyframe.art, assetId),
  );
}
