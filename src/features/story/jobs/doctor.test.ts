import { beforeEach, describe, expect, it } from "vitest";

import type { StoryJobItem, StoryJobRecord } from "../../../api/story";
import { buildStoryMokaFile } from "../../../shared/domain/fixtures";
import {
  clearDoctorAttempts,
  forgetAnswerRepair,
  MAX_ANSWER_REPAIRS,
  planAnswerRepair,
} from "./doctor";

const story = buildStoryMokaFile().stories![0]!;

function item(overrides: Partial<StoryJobItem> = {}): StoryJobItem {
  return {
    id: "outline",
    target: { kind: "outline" },
    capability: "text",
    prompt: "Write the chapters as one json table.",
    system: "Answer with one json shape.",
    inputs: [],
    params: {},
    status: "succeeded",
    text: "I am afraid I cannot help with that.",
    ...overrides,
  };
}

function record(item: StoryJobItem): StoryJobRecord {
  return {
    id: "job-outline",
    projectId: "project-1",
    storyId: story.id,
    kind: "outline",
    status: "succeeded",
    model: "a-storyteller",
    items: [item],
    cancelRequested: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

beforeEach(clearDoctorAttempts);

describe("repairing a written answer", () => {
  it("asks the same place again with the reading's own reason", () => {
    const asked = planAnswerRepair(story, record(item()), {
      id: "outline",
      kind: "outline",
    });

    expect(asked?.id).toBe("outline");
    expect(asked?.target).toEqual({ kind: "outline" });
    expect(asked?.system).toBe("Answer with one json shape.");
    expect(asked?.prompt).toContain("Write the chapters as one json table.");
    expect(asked?.prompt).toContain("Your previous answer could not be used");
    expect(asked?.prompt).toContain("I am afraid I cannot help with that.");
  });

  it("stops after the last attempt", () => {
    const held = record(item());
    for (let at = 0; at < MAX_ANSWER_REPAIRS; at += 1) {
      expect(
        planAnswerRepair(story, held, { id: "outline", kind: "outline" }),
      ).toBeDefined();
    }
    expect(
      planAnswerRepair(story, held, { id: "outline", kind: "outline" }),
    ).toBeUndefined();
  });

  it("starts over once an answer for the place came home whole", () => {
    const held = record(item());
    for (let at = 0; at < MAX_ANSWER_REPAIRS; at += 1) {
      planAnswerRepair(story, held, { id: "outline", kind: "outline" });
    }
    forgetAnswerRepair(story.id, "outline", "outline");
    expect(
      planAnswerRepair(story, held, { id: "outline", kind: "outline" }),
    ).toBeDefined();
  });

  it("repairs a whole element reading but not one part of a manuscript", () => {
    const whole = record(
      item({
        id: "elements",
        target: { kind: "elements" },
        prompt: "List what this telling is made of.",
      }),
    );
    expect(
      planAnswerRepair(story, whole, { id: "elements", kind: "elements" }),
    ).toBeDefined();

    const part = record(
      item({
        id: "elements:1",
        target: { kind: "elements" },
        prompt: "List what this telling is made of.",
      }),
    );
    expect(
      planAnswerRepair(story, part, { id: "elements:1", kind: "elements" }),
    ).toBeUndefined();
  });

  it("leaves a readable answer alone", () => {
    const held = record(
      item({
        text: JSON.stringify({
          chapters: [{ title: "一", synopsis: "他等车。" }],
        }),
      }),
    );
    expect(
      planAnswerRepair(story, held, { id: "outline", kind: "outline" }),
    ).toBeUndefined();
  });
});
