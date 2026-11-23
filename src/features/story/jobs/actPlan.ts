/**
 * The plans a chapter's acts are written from, before their shots.
 *
 * A plan is prose about the beat, the place and the time an act needs. It is
 * written onto acts rather than beside them: a chapter with no acts is given
 * the acts the plan names, and a chapter that already has them has its own
 * kept — ids, shots, pictures and clips — and only the words moved.
 */

import type { DocumentCommand } from "../../../shared/domain/types";
import type { StoryChapter, StoryDocument } from "../../../shared/domain/types";
import { ACT_PLAN_MAX } from "../../../shared/domain/constants";
import { createAct } from "../../../shared/domain/factories";
import { parseStoryJson } from "../../../shared/domain/parse/json";
import type { StoryJobItem } from "../../../api/story";

/** One act as a plan wrote it. */
export interface ActPlanDraft {
  actId?: string;
  title: string;
  summary: string;
  plan: string;
}

/** What a plan's answer said, read strictly. */
export type ActPlanRead =
  { ok: true; drafts: ActPlanDraft[] } | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function words(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const PLAN_KEYS = new Set(["actId", "title", "summary", "plan"]);

/** The acts a plan's answer holds, or why the answer cannot be used. */
export function readActPlanAnswer(item: StoryJobItem): ActPlanRead {
  const read = parseStoryJson(item.text ?? "");
  if (!read.ok) return { ok: false, error: read.error };
  if (!isObject(read.value) || !Array.isArray(read.value.acts)) {
    return { ok: false, error: "the answer held no list of acts" };
  }
  if (read.value.acts.length === 0) {
    return { ok: false, error: "the answer planned no acts" };
  }
  const drafts: ActPlanDraft[] = [];
  for (const [at, entry] of read.value.acts.entries()) {
    const where = `act ${at + 1}`;
    if (!isObject(entry)) {
      return { ok: false, error: `${where} was not an object` };
    }
    for (const key of Object.keys(entry)) {
      if (!PLAN_KEYS.has(key)) {
        return { ok: false, error: `${where} carried ${key}` };
      }
    }
    const title = words(entry.title)?.trim() ?? "";
    const plan = words(entry.plan)?.trim() ?? "";
    const actId = words(entry.actId);
    if (title === "") return { ok: false, error: `${where} had no title` };
    if (plan === "") return { ok: false, error: `${where} had no plan` };
    drafts.push({
      ...(actId === undefined ? {} : { actId }),
      title,
      summary: words(entry.summary)?.trim() ?? "",
      plan: Array.from(plan).slice(0, ACT_PLAN_MAX).join(""),
    });
  }
  return { ok: true, drafts };
}

export interface ActPlanApplication {
  commands: DocumentCommand[];
  changed: number;
  error?: string;
}

/** The chapter with a plan written onto the acts it names. */
export function applyActPlan(
  story: StoryDocument,
  chapter: StoryChapter,
  item: StoryJobItem,
): ActPlanApplication {
  const read = readActPlanAnswer(item);
  if (!read.ok) return { commands: [], changed: 0, error: read.error };
  const targetId =
    item.target.kind === "actPlan" ? item.target.actId : undefined;

  if (targetId !== undefined) {
    if (read.drafts.length !== 1) {
      return {
        commands: [],
        changed: 0,
        error: "a single act's plan held more than one act",
      };
    }
    const held = chapter.acts.find(
      (act) => act.id === targetId && act.transition === undefined,
    );
    if (held === undefined) {
      return { commands: [], changed: 0, error: "the act is no longer here" };
    }
    const draft = read.drafts[0]!;
    const acts = chapter.acts.map((act) =>
      act.id === held.id
        ? {
            ...act,
            title: draft.title,
            summary: draft.summary === "" ? act.summary : draft.summary,
            plan: draft.plan,
          }
        : act,
    );
    return {
      commands: [
        {
          type: "setStoryActs",
          storyId: story.id,
          chapterId: chapter.id,
          acts,
        },
      ],
      changed: 1,
    };
  }

  const regular = chapter.acts.filter((act) => act.transition === undefined);
  if (regular.length === 0) {
    const created = read.drafts.map((draft) => ({
      ...createAct(draft.title, draft.summary),
      plan: draft.plan,
    }));
    return {
      commands: [
        {
          type: "setStoryActs",
          storyId: story.id,
          chapterId: chapter.id,
          acts: [...chapter.acts, ...created],
        },
      ],
      changed: created.length,
    };
  }

  if (read.drafts.length !== regular.length) {
    return {
      commands: [],
      changed: 0,
      error: `the chapter has ${regular.length} acts and the plan wrote ${read.drafts.length}`,
    };
  }
  const byId = new Map(regular.map((act) => [act.id, act]));
  const named = read.drafts.some((draft) => draft.actId !== undefined);
  const updates = new Map<string, ActPlanDraft>();
  for (const [index, draft] of read.drafts.entries()) {
    const held = named
      ? draft.actId === undefined
        ? undefined
        : byId.get(draft.actId)
      : regular[index];
    if (held === undefined || updates.has(held.id)) {
      return {
        commands: [],
        changed: 0,
        error: "the plan did not name the chapter's acts as they stand",
      };
    }
    updates.set(held.id, draft);
  }
  const acts = chapter.acts.map((act) => {
    const draft = updates.get(act.id);
    if (draft === undefined) return act;
    return {
      ...act,
      title: draft.title,
      summary: draft.summary === "" ? act.summary : draft.summary,
      plan: draft.plan,
    };
  });
  return {
    commands: [
      {
        type: "setStoryActs",
        storyId: story.id,
        chapterId: chapter.id,
        acts,
      },
    ],
    changed: updates.size,
  };
}
