import type { TFunction } from "i18next";

import type { StoryJobItem } from "../../../api/story";
import {
  actAt,
  elementForm,
  elementOf,
  formName,
  keyframeAt,
} from "../../../shared/domain/story";
import type { StoryDocument } from "../../../shared/domain/types";

/**
 * What one failed piece was making, in the words of the panel that lists it.
 *
 * A batch names its pieces by the place they answer for, so the same sentence
 * a reader would use for the place — chapter, act, frame, character — is what
 * the failure is said against. A place the story no longer holds is said as
 * such rather than left blank: a failure row still has to say what it was.
 */
export function failurePieceLabel(
  story: StoryDocument,
  item: StoryJobItem,
  t: TFunction,
): string {
  const gone = t("story:jobs.failureGone");
  const target = item.target;

  const chapter = (id: string): number | null => {
    const index = story.chapters.findIndex((held) => held.id === id);
    return index === -1 ? null : index + 1;
  };
  const chapterText = (id: string): string | null => {
    const number = chapter(id);
    return number === null ? null : t("story:jobs.pieceChapter", { number });
  };
  const actText = (chapterId: string, actId: string): string | null => {
    const act = actAt(story, chapterId, actId);
    if (act === undefined) return null;
    const held = story.chapters.find((each) => each.id === chapterId);
    const index =
      held === undefined
        ? -1
        : held.acts.findIndex((each) => each.id === act.id);
    return index === -1
      ? null
      : t("story:jobs.pieceAct", { number: index + 1 });
  };
  const frameText = (
    chapterId: string,
    actId: string,
    keyframeId: string,
  ): string | null => {
    const act = actAt(story, chapterId, actId);
    if (act === undefined) return null;
    const index = act.keyframes.findIndex((held) => held.id === keyframeId);
    return index === -1
      ? null
      : t("story:jobs.pieceFrame", { number: index + 1 });
  };
  const join = (...parts: Array<string | null>): string | null =>
    parts.some((part) => part === null) ? null : parts.join(" · ");

  switch (target.kind) {
    case "outline": {
      const rewrite = /^outline:rewrite:(\d+)$/.exec(item.id);
      const legacy = /^outline:(\d+)$/.exec(item.id);
      const number = rewrite?.[1] ?? legacy?.[1];
      if (number !== undefined) {
        const held = story.chapters[Number(number) - 1];
        if (held === undefined) return gone;
        return (
          join(
            t("story:jobs.pieceChapter", { number: Number(number) }),
            t("story:jobs.pieceOutline"),
          ) ?? gone
        );
      }
      const split = /^outline:split:(\d+)$/.exec(item.id);
      if (split !== null) {
        return t("story:jobs.pieceOutlinePart", { part: Number(split[1]) });
      }
      return t("story:jobs.pieceOutlineWhole");
    }
    case "elements":
      return t("story:jobs.pieceElements");
    case "storyboard":
      return (
        join(chapterText(target.chapterId), t("story:jobs.pieceBoard")) ?? gone
      );
    case "outlineRevision":
      return (
        join(chapterText(target.chapterId), t("story:jobs.pieceRevision")) ??
        gone
      );
    case "elementArt": {
      const element = elementOf(story, target.elementId);
      if (element === undefined) return gone;
      const view = t(
        target.view === "main"
          ? "story:elements.main"
          : "story:elements.turnaround",
      );
      return t("story:jobs.pieceElement", {
        name: formName(element, elementForm(element, target.variantId)),
        view,
      });
    }
    case "keyframeArt":
      return (
        join(
          chapterText(target.chapterId),
          actText(target.chapterId, target.actId),
          frameText(target.chapterId, target.actId, target.keyframeId),
          t("story:jobs.pieceArt"),
        ) ?? gone
      );
    case "actVideo":
      return (
        join(
          chapterText(target.chapterId),
          actText(target.chapterId, target.actId),
          t("story:jobs.pieceVideo"),
        ) ?? gone
      );
    case "keyframeVideo":
      return (
        join(
          chapterText(target.chapterId),
          actText(target.chapterId, target.actId),
          frameText(target.chapterId, target.actId, target.keyframeId),
          t("story:jobs.pieceVideo"),
        ) ?? gone
      );
    case "voice":
      return (
        join(
          chapterText(target.chapterId),
          actText(target.chapterId, target.actId),
          t("story:jobs.pieceVoice"),
        ) ?? gone
      );
    case "lineVoice": {
      const line = keyframeAt(story, target)?.dialogue.find(
        (held) => held.id === target.lineId,
      );
      const said =
        line === undefined
          ? null
          : `「${line.text.length > 16 ? `${line.text.slice(0, 16)}…` : line.text}」`;
      return (
        join(
          chapterText(target.chapterId),
          actText(target.chapterId, target.actId),
          frameText(target.chapterId, target.actId, target.keyframeId),
          t("story:jobs.pieceLineVoice"),
          said,
        ) ?? gone
      );
    }
    case "music":
      return (
        join(
          chapterText(target.chapterId),
          actText(target.chapterId, target.actId),
          t("story:jobs.pieceMusic"),
        ) ?? gone
      );
  }
}
