import { afterEach, describe, expect, it, vi } from "vitest";

import { storyApi, type StoryJobRecord } from "./story";

interface Sent {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

let sent: Sent[] = [];

function stub(payload: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
}

function record(overrides: Partial<StoryJobRecord> = {}): StoryJobRecord {
  return {
    id: "job-1",
    projectId: "project-1",
    storyId: "story-1",
    kind: "keyframeArt",
    status: "queued",
    model: "a-painter",
    items: [],
    cancelRequested: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

afterEach(() => {
  sent = [];
  vi.unstubAllGlobals();
});

describe("story job client", () => {
  it("starts a batch with the story, the kind and the pieces", async () => {
    stub(record());

    await storyApi.start("story-1", "keyframeArt", [
      {
        id: "keyframe:chapter-1:act-1:frame-1",
        target: {
          kind: "keyframeArt",
          chapterId: "chapter-1",
          actId: "act-1",
          keyframeId: "frame-1",
        },
        capability: "image",
        prompt: "雨中的站台",
      },
    ]);

    expect(sent[0].url).toBe("/api/v1/projects/current/story/jobs");
    expect(sent[0].method).toBe("POST");
    expect(sent[0].body).toEqual({
      storyId: "story-1",
      kind: "keyframeArt",
      model: null,
      items: [
        {
          id: "keyframe:chapter-1:act-1:frame-1",
          target: {
            kind: "keyframeArt",
            chapterId: "chapter-1",
            actId: "act-1",
            keyframeId: "frame-1",
          },
          capability: "image",
          prompt: "雨中的站台",
        },
      ],
    });
  });

  it("carries the model the room picked, when it picked one", async () => {
    stub(record());

    await storyApi.start("story-1", "outline", [], "scribe-2");

    expect(sent[0].body).toMatchObject({ model: "scribe-2" });
  });

  it("carries the count the batch may run at once", async () => {
    stub(record());

    await storyApi.start("story-1", "elementArt", [], null, 4);

    expect(sent[0].body).toMatchObject({ parallel: 4 });
  });

  it("lists one story's batches, or the project's when none is named", async () => {
    stub([record()]);

    await storyApi.list("story-1");
    await storyApi.list();

    expect(sent.map((call) => call.url)).toEqual([
      "/api/v1/projects/current/story/jobs?storyId=story-1",
      "/api/v1/projects/current/story/jobs",
    ]);
    expect(sent.every((call) => call.method === "GET")).toBe(true);
  });

  it("reads one batch by id", async () => {
    stub(record({ status: "running" }));

    const held = await storyApi.get("job-1");

    expect(sent[0].url).toBe("/api/v1/projects/current/story/jobs/job-1");
    expect(sent[0].method).toBe("GET");
    expect(held.status).toBe("running");
  });

  it("asks a batch to stop and reads back the record as it stands", async () => {
    // A batch being driven is answered before it has an ending: the request is
    // what the record says, and the ending arrives by polling.
    stub(record({ status: "running", cancelRequested: true }));

    const held = await storyApi.cancel("job-1");

    expect(sent[0].url).toBe(
      "/api/v1/projects/current/story/jobs/job-1/cancel",
    );
    expect(sent[0].method).toBe("POST");
    expect(held.cancelRequested).toBe(true);
    expect(held.status).toBe("running");
  });
});
