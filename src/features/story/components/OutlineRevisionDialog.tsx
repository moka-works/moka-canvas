import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { StoryJobRecord } from "../../../api/story";
import {
  currentTake,
  videoPromptOverride,
  type StoryChapter,
  type StoryDocument,
  type StoryKeyframe,
} from "../../../shared/domain";
import { chapterBoardRevision } from "../../../shared/domain/story";
import { jobKey } from "../jobs/plan";
import {
  applyRevision,
  readRevisionAnswer,
  revisionItemOf,
  revisionStampOf,
  selectAllRevision,
  type RevisionAnswer,
  type RevisionKeyframePatch,
  type RevisionReferenceChange,
  type RevisionSelection,
} from "../jobs/revision";

/**
 * A revision's proposal, as the reader settles it.
 *
 * The whole answer is shown before a word of it is written: each shot with the
 * words it has and the words it would get, the cast it would name, and what has
 * already been made from it. A shot the reader leaves out is not changed, and
 * then the board stays behind the outline — a revision is all of what was
 * proposed, or the update button goes on saying so.
 */
export function OutlineRevisionDialog({
  story,
  chapter,
  record,
  onClose,
  onDiscard,
  onApply,
  onRebuild,
  onRetry,
}: {
  story: StoryDocument;
  chapter: StoryChapter;
  record: StoryJobRecord;
  onClose: () => void;
  onDiscard: () => void;
  onApply: (
    answer: RevisionAnswer,
    selection: RevisionSelection,
    revision: number,
  ) => void;
  onRebuild: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const item = revisionItemOf(record, chapter.id);
  const stamp = item === undefined ? undefined : revisionStampOf(item.id);
  const reading = useMemo(
    () =>
      item === undefined
        ? { warnings: [], error: "the batch holds no piece for this chapter" }
        : readRevisionAnswer(chapter, item.text ?? ""),
    [chapter, item],
  );
  const answer = reading.answer;
  const [selection, setSelection] = useState<RevisionSelection>(() =>
    answer === undefined
      ? { keyframes: new Set(), acts: new Set() }
      : selectAllRevision(answer),
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const structural =
    answer !== undefined && (answer.needsRebuild || answer.unmapped.length > 0);
  const preview =
    answer !== undefined && stamp !== undefined && !structural
      ? applyRevision(story, chapter, answer, stamp.revision, selection)
      : undefined;
  const stale = preview?.stale === true;
  const complete = preview?.complete === true;
  const selected =
    answer === undefined
      ? 0
      : answer.keyframes.filter((patch) =>
          selection.keyframes.has(patch.keyframeId),
        ).length +
        answer.acts.filter((patch) => selection.acts.has(patch.actId)).length;
  const referenced = new Map(
    (preview?.references ?? []).map((change) => [change.keyframeId, change]),
  );

  const toggleFrame = (id: string) => {
    setSelection((held) => {
      const keyframes = new Set(held.keyframes);
      if (keyframes.has(id)) keyframes.delete(id);
      else keyframes.add(id);
      return { ...held, keyframes };
    });
  };
  const toggleAct = (id: string) => {
    setSelection((held) => {
      const acts = new Set(held.acts);
      if (acts.has(id)) acts.delete(id);
      else acts.add(id);
      return { ...held, acts };
    });
  };

  const applyLabel = stale
    ? t("story:storyboard.revisionStale")
    : selected === 0 && complete
      ? t("story:storyboard.revisionSyncOnly")
      : complete
        ? t("story:storyboard.revisionApply", {
            count: selected,
            revision: stamp?.revision ?? 0,
          })
        : t("story:storyboard.revisionApplyPartial", {
            count: selected,
            board: chapterBoardRevision(chapter),
          });

  const dead = answer === undefined || stale || (!complete && selected === 0);

  return createPortal(
    <div
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        aria-labelledby="board-revision-title"
        aria-modal="true"
        className="dialog is-wide"
        data-testid="story-board-revision-dialog"
        role="alertdialog"
      >
        <h2 id="board-revision-title">{t("story:storyboard.revisionTitle")}</h2>

        {reading.error !== undefined ? (
          <p className="dialog-error" data-testid="story-board-revision-error">
            {t("story:storyboard.revisionUnreadable", {
              reason: reading.error,
            })}
          </p>
        ) : answer === undefined ? null : (
          <>
            <p
              className="story-hint"
              data-testid="story-board-revision-summary"
            >
              {t("story:storyboard.revisionSummary", {
                frames: answer.keyframes.length,
                acts: answer.acts.length,
                drawn: answer.keyframes.filter((patch) => {
                  const frame = frameOf(chapter, patch.keyframeId);
                  return (
                    frame !== undefined && currentTake(frame.art) !== undefined
                  );
                }).length,
                filmed: answer.keyframes.filter((patch) => {
                  const frame = frameOf(chapter, patch.keyframeId);
                  return (
                    frame !== undefined &&
                    currentTake(frame.video) !== undefined
                  );
                }).length,
                voiced: answer.keyframes.filter((patch) => {
                  const frame = frameOf(chapter, patch.keyframeId);
                  return (
                    frame !== undefined &&
                    (frame.voices ?? []).some(
                      (voice) => currentTake(voice.slot) !== undefined,
                    )
                  );
                }).length,
              })}
            </p>
            {answer.summary !== "" && (
              <p className="dialog-note">{answer.summary}</p>
            )}
            {answer.needsRebuild && (
              <p
                className="dialog-note"
                data-testid="story-board-revision-rebuild-note"
              >
                {t("story:storyboard.revisionStructuralChange")}
              </p>
            )}
            {answer.unmapped.length > 0 && (
              <p
                className="dialog-note"
                data-testid="story-board-revision-unmapped"
              >
                {t("story:storyboard.revisionUnmapped", {
                  items: answer.unmapped.join("; "),
                })}
              </p>
            )}
            {reading.warnings.length > 0 && (
              <p className="dialog-note">
                {t("story:storyboard.revisionWarnings", {
                  notes: reading.warnings.join(" "),
                })}
              </p>
            )}
            {stale ? (
              <p
                className="dialog-error"
                data-testid="story-board-revision-stale"
              >
                {t("story:storyboard.revisionStale")}
              </p>
            ) : (
              <div className="story-revision-list">
                {chapter.acts
                  .filter((act) => act.transition === undefined)
                  .map((act) => {
                    const actPatch = answer.acts.find(
                      (patch) => patch.actId === act.id,
                    );
                    const kept = answer.keyframes.filter(
                      (patch) => patch.actId === act.id,
                    );
                    if (actPatch === undefined && kept.length === 0) {
                      return null;
                    }
                    return (
                      <div className="story-revision-act" key={act.id}>
                        <div className="story-revision-act-head">
                          {actPatch !== undefined && (
                            <input
                              checked={selection.acts.has(act.id)}
                              data-testid={`story-board-revision-act-${act.id}`}
                              onChange={() => toggleAct(act.id)}
                              type="checkbox"
                            />
                          )}
                          <strong>{act.title}</strong>
                          {actPatch?.summary !== undefined &&
                            actPatch.summary !== act.summary && (
                              <span className="story-revision-field">
                                {t("story:storyboard.revisionActSummary")}{" "}
                                {act.summary} → {actPatch.summary}
                              </span>
                            )}
                        </div>
                        {kept.map((patch) => {
                          const frame = frameOf(chapter, patch.keyframeId);
                          if (frame === undefined) return null;
                          return (
                            <RevisionRow
                              checked={selection.keyframes.has(
                                patch.keyframeId,
                              )}
                              frame={frame}
                              key={patch.keyframeId}
                              manual={manualVideoPrompt(
                                story,
                                chapter.id,
                                act.id,
                                patch.keyframeId,
                              )}
                              onToggle={() => toggleFrame(patch.keyframeId)}
                              patch={patch}
                              reference={referenced.get(patch.keyframeId)}
                            />
                          );
                        })}
                      </div>
                    );
                  })}
                {answer.acts.length === 0 && answer.keyframes.length === 0 && (
                  <p className="dialog-note">
                    {t("story:storyboard.revisionNoChange")}
                  </p>
                )}
              </div>
            )}
          </>
        )}

        <div className="dialog-actions">
          {answer !== undefined && (
            <button
              className="link"
              data-testid="story-board-revision-discard"
              onClick={onDiscard}
              type="button"
            >
              {t("story:storyboard.revisionDiscard")}
            </button>
          )}
          {reading.error !== undefined || stale ? (
            <>
              <button
                data-testid="story-board-revision-close"
                onClick={onClose}
                type="button"
              >
                {t("story:storyboard.revisionClose")}
              </button>
              <button
                className="primary"
                data-testid="story-board-revision-retry"
                onClick={onRetry}
                type="button"
              >
                {t("story:storyboard.revisionRetry")}
              </button>
            </>
          ) : structural ? (
            <>
              <button
                data-testid="story-board-revision-close"
                onClick={onClose}
                type="button"
              >
                {t("story:storyboard.revisionClose")}
              </button>
              <button
                className="primary"
                data-testid="story-board-revision-rebuild"
                onClick={onRebuild}
                type="button"
              >
                {t("story:storyboard.revisionUseRebuild")}
              </button>
            </>
          ) : (
            <>
              <button
                data-testid="story-board-revision-close"
                onClick={onClose}
                type="button"
              >
                {t("story:storyboard.revisionClose")}
              </button>
              <button
                className="primary"
                data-testid="story-board-revision-apply"
                disabled={dead}
                onClick={() => {
                  if (answer === undefined || stamp === undefined) return;
                  if (preview === undefined || preview.stale) return;
                  onApply(answer, selection, stamp.revision);
                }}
                type="button"
              >
                {applyLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function RevisionRow({
  frame,
  patch,
  checked,
  manual,
  reference,
  onToggle,
}: {
  frame: StoryKeyframe;
  patch: RevisionKeyframePatch;
  checked: boolean;
  manual: boolean;
  reference: RevisionReferenceChange | undefined;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const made: string[] = [];
  if (currentTake(frame.art) !== undefined) {
    made.push(t("story:storyboard.revisionMadeFrame"));
  }
  if (currentTake(frame.video) !== undefined) {
    made.push(t("story:storyboard.revisionMadeClip"));
  }
  if (
    (frame.voices ?? []).some((voice) => currentTake(voice.slot) !== undefined)
  ) {
    made.push(t("story:storyboard.revisionMadeVoice"));
  }
  const framing = [
    patch.shotSize !== undefined && patch.shotSize !== frame.shotSize
      ? `${t("story:storyboard.revisionShotSize")}: ${frame.shotSize} → ${patch.shotSize}`
      : "",
    patch.cameraMove !== undefined && patch.cameraMove !== frame.cameraMove
      ? `${t("story:storyboard.revisionCameraMove")}: ${frame.cameraMove} → ${patch.cameraMove}`
      : "",
    patch.angle !== undefined && patch.angle !== frame.angle
      ? `${t("story:storyboard.revisionAngle")}: ${frame.angle} → ${patch.angle}`
      : "",
  ].filter((line) => line !== "");

  return (
    <div className="story-revision-row">
      <label className="story-revision-check">
        <input
          checked={checked}
          data-testid={`story-board-revision-frame-${frame.id}`}
          onChange={onToggle}
          type="checkbox"
        />
        <span>
          {frame.title} · {frame.shotSize} / {frame.cameraMove} / {frame.angle}
        </span>
      </label>
      {patch.reason !== undefined && (
        <span className="story-hint">{patch.reason}</span>
      )}
      {patch.content !== undefined && (
        <div className="story-revision-words">
          <div>
            <span className="story-hint">
              {t("story:storyboard.revisionBefore")}
            </span>
            <p>{frame.content}</p>
          </div>
          <div>
            <span className="story-hint">
              {t("story:storyboard.revisionAfter")}
            </span>
            <p>{patch.content}</p>
          </div>
        </div>
      )}
      {patch.motion !== undefined && (
        <div className="story-revision-words">
          <div>
            <span className="story-hint">
              {t("story:storyboard.revisionMotionBefore")}
            </span>
            <p>
              {frame.motion === undefined || frame.motion.trim() === ""
                ? t("story:storyboard.revisionNone")
                : frame.motion}
            </p>
          </div>
          <div>
            <span className="story-hint">
              {t("story:storyboard.revisionMotionAfter")}
            </span>
            <p>
              {patch.motion.trim() === ""
                ? t("story:storyboard.revisionNone")
                : patch.motion}
            </p>
          </div>
        </div>
      )}
      {patch.dialogue !== undefined && (
        <div className="story-revision-words">
          <div>
            <span className="story-hint">
              {t("story:storyboard.revisionDialogueBefore")}
            </span>
            <DialogueLines
              lines={frame.dialogue.map((line) => ({
                speaker: line.speaker,
                text: line.text,
              }))}
              none={t("story:storyboard.revisionNone")}
            />
          </div>
          <div>
            <span className="story-hint">
              {t("story:storyboard.revisionDialogueAfter")}
            </span>
            <DialogueLines
              lines={patch.dialogue.map((line) => ({
                speaker: line.speaker,
                text: line.text,
              }))}
              none={t("story:storyboard.revisionNone")}
            />
          </div>
        </div>
      )}
      {framing.length > 0 && (
        <span className="story-revision-field">{framing.join(" · ")}</span>
      )}
      {reference !== undefined && (
        <span className="story-revision-field">
          {t("story:storyboard.revisionReferences", {
            before:
              reference.before.join(", ") || t("story:storyboard.revisionNone"),
            after:
              reference.after.join(", ") || t("story:storyboard.revisionNone"),
          })}
        </span>
      )}
      <span className="story-hint">
        {made.length === 0
          ? t("story:storyboard.revisionNothingMade")
          : t("story:storyboard.revisionMade", { made: made.join(", ") })}
      </span>
      {manual && (
        <span className="story-hint story-revision-warning">
          {t("story:storyboard.revisionManual")}
        </span>
      )}
    </div>
  );
}

function DialogueLines({
  lines,
  none,
}: {
  lines: Array<{ speaker: string; text: string }>;
  none: string;
}) {
  if (lines.length === 0) return <p className="story-hint">{none}</p>;
  return (
    <ul className="story-revision-lines">
      {lines.map((line, at) => (
        <li key={at}>
          <b>{line.speaker}</b> {line.text}
        </li>
      ))}
    </ul>
  );
}

function frameOf(
  chapter: StoryChapter,
  keyframeId: string,
): StoryKeyframe | undefined {
  for (const act of chapter.acts) {
    if (act.transition !== undefined) continue;
    const held = act.keyframes.find((keyframe) => keyframe.id === keyframeId);
    if (held !== undefined) return held;
  }
  return undefined;
}

/** Whether a shot's clip words were written by hand rather than by the board. */
function manualVideoPrompt(
  story: StoryDocument,
  chapterId: string,
  actId: string,
  keyframeId: string,
): boolean {
  const shot = jobKey({
    kind: "keyframeVideo",
    chapterId,
    actId,
    keyframeId,
  });
  if (videoPromptOverride(story, shot) !== undefined) return true;
  const act = jobKey({ kind: "actVideo", chapterId, actId });
  return Object.keys(story.videoPromptOverrides ?? {}).some((key) =>
    key.startsWith(`${act}:`),
  );
}
