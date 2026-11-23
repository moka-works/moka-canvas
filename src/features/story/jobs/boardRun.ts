/**
 * Boarding chapters with the answer checked before it is written.
 *
 * A model asked for a board can lose an act, forget who speaks, or plan a shot
 * no clip can hold. Writing that board down is worse than writing none: the
 * room would show a board it cannot film and call the step done. So an answer
 * is read, checked, and — when it does not hold — asked about again with the
 * differences in hand. What still does not hold after the last ask is written
 * as the best board it could be, or as one plain act and shot, and said aloud.
 */

import { liveStory } from "../panels/removeOldTake";
import { chapterText } from "../readText";
import {
  spreadWaves,
  useStoryJobStore,
  waitForJob,
} from "../stores/storyJobStore";
import type { StoryJobItemDraft } from "../../../api/story";
import {
  MAX_KEYFRAME_MS,
  MIN_KEYFRAME_MS,
} from "../../../shared/domain/constants";
import { chapterActPlan, type ActDraft } from "../../../shared/domain/story";
import type { StoryChapter, StoryDocument } from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { useAppStore } from "../../editor/stores/appStore";
import { boardCommands, readBoardAnswer, type BoardReading } from "./apply";
import { checkBoard, type BoardCheck } from "./board";
import { planStoryboard, planStoryboardRepair, videoCeiling } from "./plan";
import { budgetProblem } from "./budget";

/** How many times a chapter's board is asked for before the last answer stands. */
const BOARD_ATTEMPTS = 3;

function toast(kind: "info" | "success" | "error", message: string): void {
  useAppStore.getState().pushToast(kind, message);
}

/** One shot, broad and still, holding the words it was written from. */
function plainShot(
  content: string,
  durationMs: number,
): ActDraft["keyframes"][number] {
  return {
    shotSize: "wide",
    cameraMove: "static",
    angle: "eyeLevel",
    content: content === "" ? "—" : content,
    motion: "",
    dialogue: [],
    durationMs,
  };
}

/**
 * The board a chapter is given when no answer could be kept.
 *
 * A planned chapter keeps every act it was planned as: the fallback is one
 * broad shot per act, each with its own plan's words, rather than one act
 * standing where the chapter's plan had several.
 */
function fallbackDrafts(chapter: StoryChapter): ActDraft[] {
  const text = chapterText(chapter);
  const words = (text === "" ? chapter.synopsis : text)
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) => line !== "");
  const content = Array.from(words ?? chapter.title)
    .slice(0, 600)
    .join("");
  const ceilingMs = Math.max(
    MIN_KEYFRAME_MS,
    Math.min(MAX_KEYFRAME_MS, videoCeiling() * 1000),
  );
  const durationMs =
    Math.round(
      Math.min(ceilingMs, Math.max(MIN_KEYFRAME_MS, chapter.targetDurationMs)) /
        100,
    ) * 100;
  const planned = chapterActPlan(chapter);
  if (planned !== undefined) {
    const each = Math.max(
      1,
      Math.floor(durationMs / planned.length / 100) * 100,
    );
    const held = new Map(chapter.acts.map((act) => [act.id, act]));
    return planned.map((plan) => {
      const act = held.get(plan.id);
      return {
        actId: plan.id,
        title: plan.title,
        summary: plan.summary,
        characters: act?.characterIds ?? [],
        ...(act?.sceneId === undefined ? {} : { scene: act.sceneId }),
        props: act?.propIds ?? [],
        sound: act?.sound ?? { music: "", sfx: "" },
        keyframes: [
          plainShot(
            Array.from(plan.plan).slice(0, 600).join(""),
            Math.max(MIN_KEYFRAME_MS, Math.min(ceilingMs, each)),
          ),
        ],
      };
    });
  }
  return [
    {
      title: chapter.title,
      summary: Array.from(chapter.synopsis).slice(0, 200).join(""),
      characters: [],
      props: [],
      sound: { music: "", sfx: "" },
      keyframes: [plainShot(content, durationMs)],
    },
  ];
}

/** The board a last answer leaves: itself when it can be read, else one shot. */
function fallbackCommands(
  story: StoryDocument,
  chapter: StoryChapter,
  reading: BoardReading,
) {
  // A planned chapter's acts are the one thing the fallback may not lose, so
  // its plan is what the last board is written from.
  const planned = chapterActPlan(chapter) !== undefined;
  const drafts =
    !planned && reading.drafts !== undefined && reading.drafts.length > 0
      ? reading.drafts
      : fallbackDrafts(chapter);
  return boardCommands(story, chapter.id, drafts);
}

/**
 * Boards these chapters, asking again while an answer cannot be kept.
 *
 * Returns when every chapter has been written, a batch could not be started,
 * or the reader stopped. A chapter whose piece failed at the provider is left
 * to the failure panel rather than given a board nobody wrote.
 */
export async function runBoards(
  storyId: string,
  chapterIds: string[],
): Promise<{ asked: boolean }> {
  const story = liveStory(storyId);
  if (story === undefined) return { asked: false };
  let asked = false;
  let pending = new Map<string, StoryJobItemDraft>();
  for (const item of planStoryboard(story, chapterIds)) {
    const chapterId =
      item.target.kind === "storyboard" ? item.target.chapterId : undefined;
    if (chapterId !== undefined) pending.set(chapterId, item);
  }
  let lastFailures = new Map<
    string,
    { reading: BoardReading; check: BoardCheck; text: string }
  >();

  for (let attempt = 1; attempt <= BOARD_ATTEMPTS; attempt += 1) {
    if (pending.size === 0) return { asked };
    const failed = new Map<
      string,
      { reading: BoardReading; check: BoardCheck; text: string }
    >();
    let cancelled = false;

    for (const wave of spreadWaves("storyboard", [...pending.values()])) {
      const record = await useStoryJobStore
        .getState()
        .start(storyId, "storyboard", wave.items, wave.model);
      if (record === null) return { asked };
      asked = true;
      // The batch cannot be looked up any more — the project moved on, or the
      // record was let go. There is nothing left to repair.
      const settled = await waitForJob(record.id).catch(() => null);
      if (settled === null) return { asked };
      if (settled.status === "cancelled") {
        cancelled = true;
        break;
      }
      const now = liveStory(storyId);
      if (now === undefined) return { asked };
      for (const item of settled.items) {
        if (item.target.kind !== "storyboard") continue;
        const chapterId = item.target.chapterId;
        const chapter = now.chapters.find((held) => held.id === chapterId);
        if (chapter === undefined) {
          pending.delete(chapterId);
          continue;
        }
        if (item.status !== "succeeded") {
          // A piece that failed at its provider is not an answer that was
          // wrong; the failure panel offers the ask again.
          pending.delete(chapterId);
          continue;
        }
        const reading = readBoardAnswer(now, item);
        const check = checkBoard(now, chapter, reading);
        if (check.errors.length === 0) {
          pending.delete(chapterId);
          continue;
        }
        failed.set(chapterId, {
          reading,
          check,
          text: item.text ?? "",
        });
      }
    }

    if (cancelled) return { asked };
    if (failed.size === 0) return { asked };
    lastFailures = failed;
    if (attempt >= BOARD_ATTEMPTS) break;

    const now = liveStory(storyId);
    if (now === undefined) return { asked };
    const repairs = new Map<string, StoryJobItemDraft>();
    for (const [chapterId, { check, text }] of failed) {
      const chapter = now.chapters.find((held) => held.id === chapterId);
      const budget = chapter === undefined ? undefined : budgetProblem(chapter);
      const repair = planStoryboardRepair(
        now,
        chapterId,
        Array.from(text).slice(0, 20_000).join(""),
        budget === undefined ? check.errors : [...check.errors, budget],
      );
      if (repair !== undefined) repairs.set(chapterId, repair);
    }
    pending = repairs;
  }

  const now = liveStory(storyId);
  if (now === undefined) return { asked };
  let written = 0;
  for (const [chapterId, { reading }] of lastFailures) {
    const chapter = now.chapters.find((held) => held.id === chapterId);
    if (chapter === undefined) continue;
    const applied = execute(
      i18n.t("story:history.apply.storyboard"),
      fallbackCommands(now, chapter, reading),
    );
    if (applied !== null) written += 1;
  }
  if (written > 0) {
    toast("info", i18n.t("story:jobs.boardFallback", { count: written }));
  }
  return { asked };
}
