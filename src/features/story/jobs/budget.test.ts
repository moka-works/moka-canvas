import { describe, expect, it } from "vitest";

import {
  createAct,
  createKeyframe,
  createTransitionAct,
} from "../../../shared/domain/factories";
import type { StoryChapter } from "../../../shared/domain/types";
import { budgetProblem, chapterBudget, plannedChapterMs } from "./budget";

function chapter(
  shots: number[],
  targetMs = 60_000,
  bridgeMs?: number,
): StoryChapter {
  const act = {
    ...createAct("第 1 幕"),
    keyframes: shots.map((ms, at) => ({
      ...createKeyframe(at),
      durationMs: ms,
    })),
  };
  return {
    id: "chapter-1",
    title: "一",
    synopsis: "他在等车。",
    targetDurationMs: targetMs,
    acts: [
      act,
      ...(bridgeMs === undefined
        ? []
        : [
            {
              ...createTransitionAct("转场"),
              transition: { prompt: "", durationMs: bridgeMs },
            },
          ]),
    ],
  };
}

describe("a chapter's budget", () => {
  it("counts every shot and every bridge", () => {
    expect(plannedChapterMs(chapter([2_000, 3_000], 60_000, 4_000))).toBe(
      9_000,
    );
  });

  it("is at peace within a quarter either way", () => {
    expect(chapterBudget(chapter([30_000, 25_000])).state).toBe("ok");
  });

  it("warns when the plan is half to twice its target", () => {
    expect(chapterBudget(chapter([30_000])).state).toBe("warn");
    expect(chapterBudget(chapter([60_000, 30_000])).state).toBe("warn");
  });

  it("stands far from a target it misses by more than that", () => {
    expect(chapterBudget(chapter([5_000])).state).toBe("far");
    expect(chapterBudget(chapter([130_000])).state).toBe("far");
  });

  it("says the difference only when a repair is already being made", () => {
    expect(budgetProblem(chapter([30_000, 25_000]))).toBeUndefined();
    expect(budgetProblem(chapter([5_000]))).toContain("should run about 60 s");
  });
});
