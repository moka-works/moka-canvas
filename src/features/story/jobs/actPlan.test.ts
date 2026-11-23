import { describe, expect, it } from "vitest";

import type { StoryJobItem } from "../../../api/story";
import { buildStoryMokaFile } from "../../../shared/domain/fixtures";
import type { DocumentCommand } from "../../../shared/domain/types";
import { applyActPlan, readActPlanAnswer } from "./actPlan";

const story = buildStoryMokaFile().stories![0]!;
const empty = story.chapters[1]!;
const boarded = story.chapters[0]!;
const act = boarded.acts[0]!;

function item(text: unknown, actId?: string): StoryJobItem {
  return {
    id:
      actId === undefined
        ? `actPlan:${empty.id}`
        : `actPlan:${empty.id}:${actId}`,
    target: {
      kind: "actPlan",
      chapterId: empty.id,
      ...(actId === undefined ? {} : { actId }),
    },
    capability: "text",
    prompt: "",
    inputs: [],
    params: {},
    status: "succeeded",
    text: JSON.stringify(text),
  };
}

function actsOf(commands: DocumentCommand[]) {
  const command = commands[0];
  if (command?.type !== "setStoryActs") throw new Error("a board write");
  return command.acts;
}

describe("reading an act plan", () => {
  it("reads each act's beat and place", () => {
    const read = readActPlanAnswer(
      item({
        acts: [
          {
            title: "站台",
            summary: "她在灯下等车。",
            plan: "她从雨里走到灯下，等到广播说车停了。",
          },
        ],
      }),
    );

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.drafts[0]?.title).toBe("站台");
    expect(read.drafts[0]?.plan).toContain("广播");
  });

  it("refuses an act with no plan", () => {
    const read = readActPlanAnswer(
      item({ acts: [{ title: "站台", summary: "等车。", plan: "" }] }),
    );
    expect(read.ok).toBe(false);
  });
});

describe("applying an act plan", () => {
  it("writes the acts a chapter with none is planned as", () => {
    const applied = applyActPlan(
      story,
      empty,
      item({
        acts: [
          {
            title: "站台",
            summary: "她在灯下等车。",
            plan: "她从雨里走到灯下。",
          },
          {
            title: "车厢",
            summary: "门关上了。",
            plan: "她上了车，门在身后合上。",
          },
        ],
      }),
    );

    expect(applied.changed).toBe(2);
    const acts = actsOf(applied.commands);
    expect(acts.map((held) => held.title)).toEqual(["站台", "车厢"]);
    expect(acts[0]?.plan).toBe("她从雨里走到灯下。");
    expect(acts[0]?.keyframes).toEqual([]);
  });

  it("keeps a boarded act's shots and pictures when its plan is rewritten", () => {
    const applied = applyActPlan(story, boarded, {
      ...item(
        {
          acts: [
            {
              actId: act.id,
              title: act.title,
              summary: act.summary,
              plan: "A new plan for the same act.",
            },
          ],
        },
        act.id,
      ),
      target: { kind: "actPlan", chapterId: boarded.id, actId: act.id },
    });

    expect(applied.changed).toBe(1);
    const written = actsOf(applied.commands)[0]!;
    expect(written.id).toBe(act.id);
    expect(written.plan).toBe("A new plan for the same act.");
    expect(written.keyframes).toEqual(act.keyframes);
    expect(written.video).toEqual(act.video);
  });

  it("refuses a plan that does not name the acts as they stand", () => {
    const applied = applyActPlan(story, boarded, {
      ...item(
        {
          acts: [
            {
              actId: "another-act",
              title: "别的幕",
              summary: "",
              plan: "换了一幕。",
            },
          ],
        },
        act.id,
      ),
      target: { kind: "actPlan", chapterId: boarded.id },
    });

    expect(applied.commands).toEqual([]);
    expect(applied.error).toContain("as they stand");
  });
});
