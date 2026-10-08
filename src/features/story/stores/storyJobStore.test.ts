// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";

import type { StoryJobRecord } from "../../../api/story";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import { useAppStore } from "../../editor/stores/appStore";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useModelStore } from "../../settings/modelStore";
import {
  jobProgress,
  redoChapterPart,
  retryFailed,
  stepFailure,
  targetRunning,
  useStoryJobStore,
  watchedStepFailure,
} from "./storyJobStore";
import { useStoryStore } from "./storyStore";

const ids = storyIds();

interface Call {
  url: string;
  method: string;
  body?: string;
}

let calls: Call[] = [];

/**
 * A local process that answers about batches: whatever the test handed over,
 * by url. The project itself is always answered, since reading a batch's
 * answers in begins by reading the project again.
 */
function serving(answers: Record<string, unknown>) {
  const routes: Record<string, unknown> = {
    "/api/v1/projects/current": {
      root: "/tmp/moka-story-jobs-test",
      moka: buildStoryMokaFile(),
      selfCheck: { ok: true, issues: [] },
      selfCheckVerified: true,
    },
    ...answers,
  };
  /** What the server last said about each batch, so a record is answered for
   * as it stands rather than as some earlier answer left it. */
  const said = new Map<string, unknown>();
  const respond = (payload: unknown, status = 200) => {
    for (const job of Array.isArray(payload) ? payload : [payload]) {
      const held = job as Partial<StoryJobRecord> | undefined;
      if (typeof held?.id === "string") said.set(held.id, held);
    }
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      // A batch's answer being written down as read is answered with the
      // record as it stands, carrying the room's own note — which is the
      // whole of what the server does with it.
      const readIn = /\/story\/jobs\/([^/?]+)\/read$/.exec(url);
      if (readIn !== null) {
        const found = said.get(readIn[1]);
        return found === undefined
          ? respond({ code: "NOT_FOUND", message: "no" }, 404)
          : respond({ ...found, readAt: "2026-01-02T00:00:00Z" });
      }
      // The longest match wins: a cancel is not the list it hangs under.
      const key = Object.keys(routes)
        .filter((each) => url.startsWith(each))
        .sort((a, b) => b.length - a.length)[0];
      const payload = key === undefined ? undefined : routes[key];
      if (payload === undefined) {
        return respond({ code: "NOT_FOUND", message: "no" }, 404);
      }
      return respond(payload);
    }),
  );
}

function job(overrides: Partial<StoryJobRecord> = {}): StoryJobRecord {
  return {
    id: "job-1",
    projectId: "project-1",
    storyId: ids.story,
    kind: "keyframeArt",
    status: "running",
    model: "a-painter",
    items: [
      {
        id: `keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameSecond}`,
        target: {
          kind: "keyframeArt",
          chapterId: ids.chapterFirst,
          actId: ids.act,
          keyframeId: ids.frameSecond,
        },
        capability: "image",
        prompt: "雨中的站台",
        inputs: [],
        params: {},
        status: "running",
      },
    ],
    cancelRequested: false,
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

/** The same record with its one piece answered and filed. */
function answered(assetId = "asset-answered"): StoryJobRecord {
  const held = job({ status: "succeeded" });
  return {
    ...held,
    items: [{ ...held.items[0], status: "succeeded", assetIds: [assetId] }],
  };
}

function open(): void {
  useProjectStore.getState().hydrate({
    moka: buildStoryMokaFile(),
    root: "/tmp/moka-story-jobs-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
}

beforeEach(() => {
  calls = [];
  vi.useFakeTimers();
  localStorage.clear();
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useStoryJobStore.getState().reset();
  open();
});

afterEach(() => {
  useStoryJobStore.getState().reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("starting a batch", () => {
  it("saves what is waiting before it asks for anything", async () => {
    serving({ "/api/v1/projects/current/story/jobs": job() });
    // A change still in this window when the batch is asked for: the server
    // answers from the document it holds, so it has to hold this first.
    await act(async () => {
      useProjectStore
        .getState()
        .applyLocal([
          { type: "renameStory", storyId: ids.story, name: "夜车" },
        ]);
    });

    const started = await useStoryJobStore
      .getState()
      .start(ids.story, "outline", []);

    expect(started?.id).toBe("job-1");
    expect(useProjectStore.getState().pending).toEqual([]);
    const saved = calls.findIndex((call) =>
      call.url.endsWith("/projects/current/commands"),
    );
    const asked = calls.findIndex(
      (call) => call.method === "POST" && call.url.endsWith("/story/jobs"),
    );
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(saved).toBeLessThan(asked);
  });

  it("asks for nothing while the document it would be asked against is unsaved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/projects/current/commands")) {
          return Promise.resolve(
            new Response(JSON.stringify({ code: "INTERNAL", message: "no" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );
    await act(async () => {
      useProjectStore
        .getState()
        .applyLocal([
          { type: "renameStory", storyId: ids.story, name: "夜车" },
        ]);
    });

    const started = await useStoryJobStore
      .getState()
      .start(ids.story, "outline", []);

    expect(started).toBeNull();
    // Why the save would not land, rather than only that one is on its way:
    // "no" is what the store was told, and waiting would not change it.
    const said = useAppStore.getState().toasts.at(-1);
    expect(said?.message).toContain("no");
    expect(said?.detail).toContain("still being saved");
  });

  it("puts the record at the head of the list and starts asking about it", async () => {
    serving({ "/api/v1/projects/current/story/jobs": job() });

    const started = await useStoryJobStore
      .getState()
      .start(ids.story, "keyframeArt", []);

    expect(started?.id).toBe("job-1");
    expect(useStoryJobStore.getState().jobs.map((held) => held.id)).toEqual([
      "job-1",
    ]);
    expect(useStoryJobStore.getState().storyId).toBe(ids.story);
    // It is running, so the room keeps looking.
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls.some((call) => call.method === "GET")).toBe(true);
  });

  it("does not ask for a place that is already on its way", async () => {
    serving({ "/api/v1/projects/current/story/jobs": job() });
    const drafts = [
      {
        id: `keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameSecond}`,
        target: {
          kind: "keyframeArt" as const,
          chapterId: ids.chapterFirst,
          actId: ids.act,
          keyframeId: ids.frameSecond,
        },
        capability: "image" as const,
        prompt: "雨中的站台",
      },
    ];

    // Two clicks in one breath, before the first batch is on the record: the
    // second is not a second ask for the same picture.
    const first = useStoryJobStore
      .getState()
      .start(ids.story, "keyframeArt", drafts);
    const second = useStoryJobStore
      .getState()
      .start(ids.story, "keyframeArt", drafts);
    const [asked, refused] = await Promise.all([first, second]);

    expect(asked?.id).toBe("job-1");
    expect(refused).toBeNull();
    expect(
      calls.filter(
        (call) => call.method === "POST" && call.url.endsWith("/story/jobs"),
      ),
    ).toHaveLength(1);

    // The place is askable again once the first ask is over, and a place
    // beside it was never held back by the one on its way.
    await useStoryJobStore.getState().start(ids.story, "keyframeArt", drafts);
    await useStoryJobStore.getState().start(ids.story, "keyframeArt", [
      {
        ...drafts[0],
        id: "keyframe-elsewhere",
        target: { ...drafts[0].target, keyframeId: "frame-elsewhere" },
      },
    ]);
    expect(
      calls.filter(
        (call) => call.method === "POST" && call.url.endsWith("/story/jobs"),
      ),
    ).toHaveLength(3);
  });

  it("keeps the reason when a batch cannot be started", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              code: "STORY_JOB_BUSY",
              message: "This story already has a job in progress",
              status: 409,
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    );

    const started = await useStoryJobStore
      .getState()
      .start(ids.story, "keyframeArt", []);

    expect(started).toBeNull();
    expect(useStoryJobStore.getState().error).toContain("already has a job");
    expect(useStoryJobStore.getState().jobs).toEqual([]);
  });

  it("sends a reader with no model for this work to the settings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              code: "PROVIDER_NOT_CONFIGURED",
              message: "No image model is configured",
              status: 422,
            }),
            { status: 422, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    );

    await useStoryJobStore.getState().start(ids.story, "keyframeArt", []);

    const toast = useAppStore.getState().toasts.at(-1);
    expect(toast?.kind).toBe("error");
    expect(toast?.choice?.label).toContain("settings");
    expect(useStoryJobStore.getState().error).toBeNull();
  });
});

describe("a batch coming back", () => {
  /** Two shots of one act, filmed as one batch. */
  function filming(): StoryJobRecord {
    const held = job({ kind: "keyframeVideo" });
    return {
      ...held,
      items: [ids.frameFirst, ids.frameSecond].map((keyframeId) => ({
        ...held.items[0],
        id: `keyframeVideo:${ids.chapterFirst}:${ids.act}:${keyframeId}`,
        target: {
          kind: "keyframeVideo" as const,
          chapterId: ids.chapterFirst,
          actId: ids.act,
          keyframeId,
        },
        capability: "video" as const,
      })),
    };
  }

  /** That batch as it stands: a piece answered here and there. */
  function filmed(
    held: StoryJobRecord,
    answers: Array<{ at: number; assetId?: string; failed?: string }>,
    status: StoryJobRecord["status"] = "running",
  ): StoryJobRecord {
    return {
      ...held,
      status,
      items: held.items.map((item, index) => {
        const answer = answers.find((each) => each.at === index);
        if (answer === undefined) return item;
        if (answer.failed !== undefined) {
          return { ...item, status: "failed" as const, error: answer.failed };
        }
        return {
          ...item,
          status: "succeeded" as const,
          assetIds: [answer.assetId ?? "asset-clip"],
        };
      }),
    };
  }

  it("writes each answer in as it lands rather than at the end of the batch", async () => {
    const held = filming();
    serving({
      "/api/v1/projects/current/story/jobs": [
        filmed(held, [{ at: 0, assetId: "asset-clip-1" }]),
      ],
    });
    const apply = vi.spyOn(useProjectStore.getState(), "applyLocal");

    await useStoryJobStore.getState().load(ids.story);

    // The clip that came home is written into its place while the batch is
    // still filming, and nothing is said yet about the batch being over.
    expect(apply).toHaveBeenCalledTimes(1);
    const asked = apply.mock.calls[0]?.[0] ?? [];
    expect(asked[0]).toMatchObject({
      type: "setStorySlot",
      target: { kind: "keyframeVideo", keyframeId: ids.frameFirst },
    });
    expect(JSON.stringify(asked[0])).toContain("asset-clip-1");
    expect(useAppStore.getState().toasts).toEqual([]);

    // The other lands and the batch ends: the answer of this look is written in
    // as well, and the count of the whole batch is said once.
    serving({
      "/api/v1/projects/current/story/jobs": [
        filmed(
          held,
          [
            { at: 0, assetId: "asset-clip-1" },
            { at: 1, assetId: "asset-clip-2" },
          ],
          "succeeded",
        ),
      ],
    });
    await useStoryJobStore.getState().load(ids.story);

    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1]?.[0]?.[0]).toMatchObject({
      target: { kind: "keyframeVideo", keyframeId: ids.frameSecond },
    });
    const toasts = useAppStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.kind).toBe("success");
    expect(toasts[0]?.message).toContain("2 answers");

    // A look at a batch that has already been read in says nothing twice.
    await useStoryJobStore.getState().load(ids.story);
    expect(useAppStore.getState().toasts).toHaveLength(1);
    // And both landings are one step of the story's history: what is undone is
    // the batch, not each picture.
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    apply.mockRestore();
  });

  it("says which model has no key, and where that is fixed", async () => {
    const held = filming();
    const short = filmed(
      held,
      [
        { at: 0, failed: "model gpt-4o-mini has no stored API key" },
        { at: 1, assetId: "asset-clip-2" },
      ],
      "failed",
    );
    serving({
      "/api/v1/projects/current/story/jobs": [
        {
          ...short,
          items: short.items.map((item, index) =>
            index === 0
              ? {
                  ...item,
                  errorCode: "PROVIDER_KEY_MISSING",
                  errorDetails: { model: "gpt-4o-mini" },
                }
              : item,
          ),
        },
      ],
    });
    const apply = vi.spyOn(useProjectStore.getState(), "applyLocal");

    await useStoryJobStore.getState().load(ids.story);

    const said = useAppStore.getState().toasts.at(-1);
    expect(said?.kind).toBe("error");
    // The reason, not only the count: what the reader could not see for
    // themselves is the whole point of saying anything at all.
    expect(said?.message).toBe(
      "1 of 2 pieces did not come back: model gpt-4o-mini has no stored API key",
    );
    // Asking the same thing again of a model that holds no key would be
    // answered the same way, so the toast offers the place that fixes it —
    // opened on the page that holds the model the pieces were asked of.
    expect(said?.choice?.label).toBe("Open settings");
    const open = vi.spyOn(useModelStore.getState(), "openSettings");
    said?.choice?.go();
    expect(open).toHaveBeenCalledWith("video");
    open.mockRestore();
    apply.mockRestore();
  });

  it("answers a voiceless batch where the voices live rather than in the settings", async () => {
    const held = job({ kind: "voice", model: "a-speaker", status: "failed" });
    const spoken: StoryJobRecord = {
      ...held,
      items: [
        {
          ...held.items[0],
          id: `voice:${ids.chapterFirst}:${ids.act}`,
          target: {
            kind: "voice",
            chapterId: ids.chapterFirst,
            actId: ids.act,
          },
          capability: "speech",
          status: "failed",
          error:
            "the model a-speaker has no voice set, and its speech converter needs one",
          errorCode: "MODEL_VOICE_REQUIRED",
          errorDetails: { model: "a-speaker" },
        },
      ],
    };
    serving({ "/api/v1/projects/current/story/jobs": [spoken] });
    const apply = vi.spyOn(useProjectStore.getState(), "applyLocal");

    await useStoryJobStore.getState().load(ids.story);

    const said = useAppStore.getState().toasts.at(-1);
    expect(said?.kind).toBe("error");
    // The characters' own voices are the repair, so the line says where they
    // are written and the press steps back into the telling — the settings
    // page offers only the machine default, which is the last link of the
    // chain rather than the one a cast is given.
    expect(said?.message).toContain("Some characters have no voice yet");
    expect(said?.message).toContain("Elements");
    expect(said?.choice?.label).toBe("Set the voices");
    const step = vi.spyOn(useStoryStore.getState(), "goStep");
    said?.choice?.go();
    expect(step).toHaveBeenCalledWith("elements");
    step.mockRestore();
    apply.mockRestore();
  });

  it("lays the reasons out under the line when pieces fell to different ones", async () => {
    const held = filming();
    serving({
      "/api/v1/projects/current/story/jobs": [
        filmed(
          held,
          [
            { at: 0, failed: "the provider is busy" },
            { at: 1, failed: "the prompt resolved to nothing" },
          ],
          "failed",
        ),
      ],
    });

    await useStoryJobStore.getState().load(ids.story);

    const said = useAppStore.getState().toasts.at(-1);
    expect(said?.message).toBe(
      "2 of 2 pieces did not come back: the provider is busy",
    );
    // Everything the batch had to say, kept under the line rather than cut.
    expect(said?.detail).toBe(
      "the provider is busy\nthe prompt resolved to nothing",
    );
  });

  it("tells what did not come back once the batch is over, failed and applied together", async () => {
    const held = filming();
    // One shot came home, the other was refused, and the batch is over.
    serving({
      "/api/v1/projects/current/story/jobs": [
        filmed(
          held,
          [
            { at: 0, assetId: "asset-clip-1" },
            { at: 1, failed: "the provider refused it" },
          ],
          "failed",
        ),
      ],
    });
    const apply = vi.spyOn(useProjectStore.getState(), "applyLocal");

    await useStoryJobStore.getState().load(ids.story);

    const messages = useAppStore
      .getState()
      .toasts.map((toast) => `${toast.kind}: ${toast.message}`);
    expect(messages).toEqual([
      "success: 1 answers were written into the story",
      "error: 1 of 2 pieces did not come back: the provider refused it",
    ]);
    expect(useAppStore.getState().toasts.at(-1)?.choice?.label).toContain(
      "Ask again",
    );

    // Nothing new to read and nothing new to say, whatever the look after.
    await useStoryJobStore.getState().load(ids.story);
    expect(useAppStore.getState().toasts).toHaveLength(2);
    expect(apply).toHaveBeenCalledTimes(1);
    apply.mockRestore();
  });

  it("reads the project again before writing the answers in", async () => {
    const order: string[] = [];
    const project = useProjectStore.getState();
    const reload = vi
      .spyOn(useProjectStore.getState(), "reload")
      .mockImplementation(async () => {
        order.push("reload");
        return true;
      });
    const apply = vi
      .spyOn(useProjectStore.getState(), "applyLocal")
      .mockImplementation(() => {
        order.push("apply");
        return [];
      });

    serving({ "/api/v1/projects/current/story/jobs": [job()] });
    await useStoryJobStore.getState().load(ids.story);

    serving({
      "/api/v1/projects/current/story/jobs/job-1": answered(),
    });
    await useStoryJobStore.getState().adopt("job-1");

    // The order matters: the assets the batch filed only exist for this client
    // after the project has been read again.
    expect(order).toEqual(["reload", "apply"]);
    expect(project.moka).not.toBeNull();
    reload.mockRestore();
    apply.mockRestore();
  });

  it("does not read an answer in twice", async () => {
    serving({ "/api/v1/projects/current/story/jobs": [answered()] });
    const reload = vi.spyOn(useProjectStore.getState(), "reload");
    const apply = vi.spyOn(useProjectStore.getState(), "applyLocal");

    await useStoryJobStore.getState().load(ids.story);
    const afterFirst = reload.mock.calls.length;
    await useStoryJobStore.getState().load(ids.story);

    expect(afterFirst).toBe(1);
    expect(reload.mock.calls.length).toBe(1);
    reload.mockRestore();
    apply.mockRestore();
  });

  it("says a look that failed, once for the reason and not once a look", async () => {
    serving({ "/api/v1/projects/current/story/jobs": [job()] });
    await useStoryJobStore.getState().load(ids.story);

    // The process goes away under the room while a batch is still out: the
    // look fails, and a look comes every second and a half.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    await vi.advanceTimersByTimeAsync(1600);
    const told = () =>
      useAppStore.getState().toasts.filter((toast) => toast.kind === "error");
    expect(told()).toHaveLength(1);
    expect(told()[0]?.message).toContain("Could not read the batches through");
    expect(told()[0]?.message).toContain("offline");

    await vi.advanceTimersByTimeAsync(1600);
    expect(told()).toHaveLength(1);
  });

  it("stops asking when nothing is running any more", async () => {
    serving({ "/api/v1/projects/current/story/jobs": [job()] });
    await useStoryJobStore.getState().load(ids.story);
    await vi.advanceTimersByTimeAsync(1600);
    const polled = calls.length;
    expect(polled).toBeGreaterThan(0);

    serving({ "/api/v1/projects/current/story/jobs": [answered()] });
    await vi.advanceTimersByTimeAsync(3200);

    // The list says the batch is done, so the room stops asking about it.
    expect(useStoryJobStore.getState().jobs[0].status).toBe("succeeded");
    const after = calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.length).toBe(after);
  });

  it("lets go of a batch the look no longer carries", async () => {
    // A failure the room has been told about, standing beside a batch that is
    // still out.
    const held = job();
    const refused: StoryJobRecord = {
      ...job({ id: "job-refused", status: "failed" }),
      items: [{ ...held.items[0], status: "failed", error: "no" }],
    };
    serving({ "/api/v1/projects/current/story/jobs": [held, refused] });
    await useStoryJobStore.getState().load(ids.story);
    expect(
      stepFailure(useStoryJobStore.getState().jobs, ids.story, "storyboard"),
    ).toEqual({ failed: 1, jobId: "job-refused", reasons: ["no"] });

    // The failure was read into the story long ago, and enough newer batches
    // have been asked for that the server stops carrying it. The room lets it
    // go with the look that dropped it rather than counting it until the next
    // reload.
    serving({ "/api/v1/projects/current/story/jobs": [held] });
    await vi.advanceTimersByTimeAsync(1600);

    expect(
      stepFailure(useStoryJobStore.getState().jobs, ids.story, "storyboard"),
    ).toBeNull();
  });

  it("keeps a batch that is still out when a look races it", async () => {
    serving({ "/api/v1/projects/current/story/jobs": job() });
    await useStoryJobStore.getState().start(ids.story, "keyframeArt", []);

    // A look whose list was put together before the ask landed does not carry
    // the batch; the room keeps it rather than losing the ask.
    serving({ "/api/v1/projects/current/story/jobs": [] });
    await vi.advanceTimersByTimeAsync(1600);

    expect(useStoryJobStore.getState().jobs.map((record) => record.id)).toEqual(
      ["job-1"],
    );
  });
});

describe("a room opened over the batches it has already read", () => {
  /** A reading of the chapters, come home with this cast. */
  function reading(id: string, at: string, names: string[]): StoryJobRecord {
    return {
      id,
      projectId: "project-1",
      storyId: ids.story,
      kind: "elements",
      status: "succeeded",
      model: "a-storyteller",
      items: [
        {
          id: "elements",
          target: { kind: "elements" },
          capability: "text",
          prompt: "the telling, chapter by chapter",
          inputs: [],
          params: {},
          status: "succeeded",
          text: JSON.stringify({
            characters: names.map((name) => ({
              name,
              description: `${name} 的样子。`,
            })),
            scenes: [],
            props: [],
          }),
        },
      ],
      cancelRequested: false,
      createdAt: at,
      updatedAt: at,
    };
  }

  /** The cast the story holds, by name. */
  function cast(): string[] {
    return (useProjectStore.getState().moka?.stories?.[0]?.elements ?? []).map(
      (element) => element.name,
    );
  }

  /** What the room wrote down about the batches, by the urls it asked. */
  function notes(): string[] {
    return calls
      .filter((call) => call.method === "POST" && call.url.endsWith("/read"))
      .map((call) => call.url.split("/").at(-2) ?? "");
  }

  /** A save that lands, which a written-in answer has to be followed by. */
  const saved = {
    "/api/v1/projects/current/commands": {
      revision: 2,
      updatedAt: "2026-01-02T00:00:00Z",
    },
  };

  it("leaves an answer the story already has alone", async () => {
    const held = reading("job-1", "2026-01-02T00:00:00Z", ["甲"]);
    serving({
      ...saved,
      "/api/v1/projects/current/story/jobs": [
        { ...held, readAt: "2026-01-02T01:00:00Z" },
      ],
    });
    const reload = vi.spyOn(useProjectStore.getState(), "reload");
    const apply = vi.spyOn(useProjectStore.getState(), "applyLocal");

    await useStoryJobStore.getState().load(ids.story);

    // The cast is the one the reader has, not the one the answer says: an
    // answer read in days ago is not a word on the story any more.
    expect(cast()).toEqual(["林", "周", "末班车车厢", "旧车票"]);
    expect(apply).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(useAppStore.getState().toasts).toEqual([]);
    reload.mockRestore();
    apply.mockRestore();
  });

  it("reads the answers in the order they were asked for, so the newest stands", async () => {
    // The server lists the newest first, and the reading of a telling comes
    // home after the board of one does not matter: the second reading is the
    // newer word on the same cast, so it is the one that has to be left.
    serving({
      ...saved,
      "/api/v1/projects/current/story/jobs": [
        reading("job-2", "2026-01-03T00:00:00Z", ["丙"]),
        reading("job-1", "2026-01-02T00:00:00Z", ["甲", "乙"]),
      ],
    });

    await useStoryJobStore.getState().load(ids.story);

    expect(cast()).toEqual(["丙"]);
    expect(notes().sort()).toEqual(["job-1", "job-2"]);
  });

  it("writes an answer down as read once it has settled, and only then", async () => {
    const held = answered(); // a keyframe's drawing, one piece of it answered
    const running: StoryJobRecord = { ...held, status: "running" };
    serving({
      ...saved,
      "/api/v1/projects/current/story/jobs": [running],
    });

    await useStoryJobStore.getState().load(ids.story);
    expect(notes()).toEqual([]);

    // The batch settles: what has been read in is written down, so a room
    // opened after this one does not read it in a second time.
    serving({
      ...saved,
      "/api/v1/projects/current/story/jobs": [
        { ...answered(), status: "succeeded" },
      ],
    });
    await useStoryJobStore.getState().load(ids.story);
    expect(notes()).toEqual(["job-1"]);
  });

  it("does not write an answer down before the save carrying it has landed", async () => {
    const held = reading("job-1", "2026-01-02T00:00:00Z", ["甲"]);
    /** A server whose commands route answers, or refuses, as the test says. */
    const stubSaving = (lands: boolean) => {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          calls.push({ url, method: init?.method ?? "GET" });
          const json = (payload: unknown, status = 200) =>
            Promise.resolve(
              new Response(JSON.stringify(payload), {
                status,
                headers: { "Content-Type": "application/json" },
              }),
            );
          if (url.endsWith("/projects/current/commands")) {
            return lands
              ? json({ revision: 2, updatedAt: "2026-01-02T00:00:00Z" })
              : json({ code: "INTERNAL", message: "no" }, 500);
          }
          if (/\/story\/jobs\/([^/?]+)\/read$/.test(url)) {
            return json({ ...held, readAt: "2026-01-02T01:00:00Z" });
          }
          if (url.includes("/story/jobs")) return json([held]);
          return json({
            root: "/tmp/moka-story-jobs-test",
            moka: buildStoryMokaFile(),
            selfCheck: { ok: true, issues: [] },
            selfCheckVerified: true,
          });
        }),
      );
    };

    stubSaving(false);
    await useStoryJobStore.getState().load(ids.story);

    // The answer is in the window and not on the server, which is no place to
    // leave a note saying it has been read in: no room would read it again.
    expect(cast()).toEqual(["甲"]);
    expect(notes()).toEqual([]);

    // Once saving works again, the note is written on the next look.
    stubSaving(true);
    await useStoryJobStore.getState().load(ids.story);
    expect(notes()).toEqual(["job-1"]);
  });

  it("asks again for an answer the document would not take", async () => {
    // A cast longer than a story may hold: the document refuses the lot, so
    // nothing of the answer is in and nothing may be written down about it.
    const tooMany = Array.from({ length: 201 }, (_, at) => `角色 ${at + 1}`);
    serving({
      ...saved,
      "/api/v1/projects/current/story/jobs": [
        reading("job-1", "2026-01-02T00:00:00Z", tooMany),
      ],
    });
    const apply = vi.spyOn(useProjectStore.getState(), "applyLocal");

    await useStoryJobStore.getState().load(ids.story);
    expect(notes()).toEqual([]);

    // The next look asks the document again rather than believing it landed.
    await useStoryJobStore.getState().load(ids.story);
    expect(apply.mock.calls.length).toBeGreaterThan(1);
    expect(notes()).toEqual([]);
    apply.mockRestore();
  });

  it("says a batch's ending once, however many rooms are opened after it", async () => {
    const failed: StoryJobRecord = {
      ...reading("job-1", "2026-01-02T00:00:00Z", []),
      status: "failed",
      items: [
        {
          id: "elements",
          target: { kind: "elements" },
          capability: "text",
          prompt: "the telling, chapter by chapter",
          inputs: [],
          params: {},
          status: "failed",
          error: "the provider refused it",
        },
      ],
    };
    serving({
      ...saved,
      "/api/v1/projects/current/story/jobs": [failed],
    });

    await useStoryJobStore.getState().load(ids.story);
    const said = useAppStore.getState().toasts.length;
    expect(said).toBe(1);
    expect(notes()).toEqual(["job-1"]);

    // A room opened after it — a restart, in so many words — has nothing to
    // say about a batch whose answer was already read in: it says nothing.
    useStoryJobStore.getState().reset();
    serving({
      ...saved,
      "/api/v1/projects/current/story/jobs": [
        { ...failed, readAt: "2026-01-02T01:00:00Z" },
      ],
    });
    await useStoryJobStore.getState().load(ids.story);
    expect(useAppStore.getState().toasts).toHaveLength(said);
  });
});

describe("cancelling a batch", () => {
  it("keeps the ending the server answered with", async () => {
    serving({
      "/api/v1/projects/current/story/jobs": [job()],
      "/api/v1/projects/current/story/jobs/job-1/cancel": job({
        status: "cancelled",
        cancelRequested: true,
      }),
    });

    await useStoryJobStore.getState().load(ids.story);
    await useStoryJobStore.getState().cancel("job-1");

    expect(useStoryJobStore.getState().jobs[0].status).toBe("cancelled");
  });
});

describe("asking again for what did not come back", () => {
  /** The story the room is looking at, as a step reads it out of the document. */
  function openStory() {
    const held = useProjectStore
      .getState()
      .moka?.stories?.find((each) => each.id === ids.story);
    if (held === undefined) throw new Error("the fixture story is open");
    return held;
  }

  /** What was asked of the server last, as it was asked. */
  function lastAsk(): { items: { id: string; prompt: string }[] } {
    const sent = calls.filter((call) => call.method === "POST").at(-1);
    if (sent?.body === undefined) throw new Error("nothing was started");
    return JSON.parse(sent.body) as { items: { id: string; prompt: string }[] };
  }

  it("sends a manuscript's part again as the part it was, not as a new outline", async () => {
    serving({ "/api/v1/projects/current/story/jobs": job() });
    const held = job({
      kind: "outline",
      items: [
        {
          ...job().items[0],
          id: "outline:2",
          target: { kind: "outline" },
          capability: "text",
          prompt:
            "Part 2 of 3 of a manuscript, which is the telling's own text:",
          status: "failed",
        },
      ],
    });

    await retryFailed(openStory(), held);

    const [again] = lastAsk().items;
    expect(again?.id).toBe("outline:2");
    expect(again?.prompt).toContain("Part 2 of 3");
  });

  it("plans an answer for every chapter again when the whole table was asked for", async () => {
    serving({ "/api/v1/projects/current/story/jobs": job() });
    const held = job({
      kind: "outline",
      items: [
        {
          ...job().items[0],
          id: "outline",
          target: { kind: "outline" },
          capability: "text",
          prompt: "an ask of an older shape",
          status: "failed",
        },
      ],
    });

    await retryFailed(openStory(), held);

    const [again] = lastAsk().items;
    expect(again?.id).toBe("outline");
    expect(again?.prompt).toContain("Write this telling as 2 chapters.");
  });

  it("asks for an act filmed in pieces once, however many pieces failed", async () => {
    // The act is one ask, however many pieces it is made of: a retry that
    // planned it once per failed piece would hand the server the same piece
    // twice, which is a batch it refuses.
    serving({ "/api/v1/projects/current/story/jobs": job() });
    const act = openStory().chapters[0]!.acts[0]!;
    act.keyframes[1]!.art = {
      takes: [
        {
          assetIds: ["asset-second-frame"],
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    // Two shots of four hundred seconds are over the thirteen minutes a clip
    // may run, so the act is asked for as two pieces.
    for (const keyframe of act.keyframes) keyframe.durationMs = 400_000;
    const base = `actVideo:${ids.chapterFirst}:${ids.act}`;
    const piece = (at: number) => ({
      ...job().items[0],
      id: `${base}:${at}`,
      target: {
        kind: "actVideo" as const,
        chapterId: ids.chapterFirst,
        actId: ids.act,
      },
      capability: "video" as const,
      status: "failed" as const,
    });
    const held = job({ kind: "actVideo", items: [piece(1), piece(2)] });

    await retryFailed(openStory(), held);

    expect(lastAsk().items.map((item) => item.id)).toEqual([
      `${base}:1`,
      `${base}:2`,
    ]);
  });

  it("asks again for one part of a manuscript from the record it was made for", async () => {
    serving({
      "/api/v1/projects/current/story/jobs": [
        job({
          kind: "outline",
          items: [
            {
              ...job().items[0],
              id: "outline:2",
              target: { kind: "outline" },
              capability: "text",
              prompt:
                "Part 2 of 3 of a manuscript, which is the telling's own text:",
              status: "succeeded",
            },
          ],
        }),
      ],
    });
    await useStoryJobStore.getState().load(ids.story);

    await redoChapterPart(openStory(), 1);

    const [again] = lastAsk().items;
    expect(again?.id).toBe("outline:2");
    expect(again?.prompt).toContain("Part 2 of 3");
  });

  it("says so when the part it would ask for is no longer on file", async () => {
    serving({ "/api/v1/projects/current/story/jobs": [] });
    await useStoryJobStore.getState().load(ids.story);

    await redoChapterPart(openStory(), 0);

    expect(useAppStore.getState().toasts.at(-1)?.message).toContain(
      "split it again",
    );
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });
});

describe("what the room reads off a list of batches", () => {
  it("counts a batch's pieces", () => {
    const held = job();
    expect(jobProgress(held)).toEqual({ done: 0, total: 1 });
    expect(jobProgress(answered())).toEqual({ done: 1, total: 1 });
  });

  it("names the step a failure belongs to", () => {
    const failed = answered();
    const withFailure: StoryJobRecord = {
      ...failed,
      items: [{ ...failed.items[0], status: "failed", error: "no" }],
    };
    expect(stepFailure([withFailure], ids.story, "storyboard")).toEqual({
      failed: 1,
      jobId: "job-1",
      reasons: ["no"],
    });
    // An element's drawing is the element step's work, not the board's.
    expect(stepFailure([withFailure], ids.story, "elements")).toBeNull();
  });

  it("stops counting a failure a later batch answered for", () => {
    // One drawing of the cast, failed, and a later ask for that same drawing
    // that answered: the badge counts the pieces a step is short of, and the
    // step has this one.
    const failed: StoryJobRecord = {
      ...answered(),
      id: "job-failed",
      kind: "elementArt",
      createdAt: "2026-01-02T00:00:00Z",
      items: [
        {
          ...answered().items[0],
          id: `element:main:${ids.hero}`,
          target: { kind: "elementArt", elementId: ids.hero, view: "main" },
          status: "failed",
          error: "no",
        },
      ],
    };
    const again: StoryJobRecord = {
      ...failed,
      id: "job-again",
      status: "succeeded",
      createdAt: "2026-01-03T00:00:00Z",
      items: [{ ...failed.items[0], status: "succeeded" }],
    };
    expect(stepFailure([again, failed], ids.story, "elements")).toBeNull();
    // The newest word on the piece is what stands: the same two batches the
    // other way round are a failure nothing has answered.
    expect(stepFailure([failed, again], ids.story, "elements")).toEqual({
      failed: 1,
      jobId: "job-failed",
      reasons: ["no"],
    });

    // A later batch that answered some other piece leaves the failure
    // standing.
    const elsewhere: StoryJobRecord = {
      ...again,
      items: [{ ...again.items[0], id: `element:main:${ids.partner}` }],
    };
    expect(stepFailure([elsewhere, failed], ids.story, "elements")).toEqual({
      failed: 1,
      jobId: "job-failed",
      reasons: ["no"],
    });

    // The words are the same story: an outline that failed and an outline
    // asked for again and answered.
    const outlineFailed: StoryJobRecord = {
      ...failed,
      kind: "outline",
      items: [
        {
          ...failed.items[0],
          id: "outline",
          target: { kind: "outline" },
          capability: "text",
        },
      ],
    };
    const outlineAgain: StoryJobRecord = {
      ...outlineFailed,
      id: "outline-again",
      items: [{ ...outlineFailed.items[0], status: "succeeded" }],
    };
    expect(
      stepFailure([outlineAgain, outlineFailed], ids.story, "outline"),
    ).toBeNull();
  });

  it("says which places are being made just now", () => {
    const key = `keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameSecond}`;
    const other = `keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`;
    expect(targetRunning([job()], ids.story, key)).toBe(true);
    expect(targetRunning([job()], ids.story, other)).toBe(false);
    // A batch that has ended is not making anything.
    expect(targetRunning([answered()], ids.story, key)).toBe(false);
    // Nor is another story's batch.
    expect(targetRunning([job()], "story-elsewhere", key)).toBe(false);
  });
});

describe("what a step's badge counts", () => {
  /** The same record, come home with its one piece short. */
  function short(record: StoryJobRecord): StoryJobRecord {
    return {
      ...record,
      status: "failed",
      items: [
        { ...record.items[0], status: "failed", error: "the provider refused" },
      ],
    };
  }

  const badge = () =>
    watchedStepFailure(
      useStoryJobStore.getState().jobs,
      ids.story,
      "storyboard",
    );

  it("counts a batch the room watched come home short", async () => {
    // The batch is out when the room opens — which is what puts the room
    // watching it — and the look that comes back says it ended a piece short.
    const out = job();
    serving({ "/api/v1/projects/current/story/jobs": [out] });
    await useStoryJobStore.getState().load(ids.story);

    serving({ "/api/v1/projects/current/story/jobs": [short(out)] });
    await vi.advanceTimersByTimeAsync(1600);

    expect(badge()).toEqual({
      failed: 1,
      jobId: "job-1",
      reasons: ["the provider refused"],
    });
  });

  it("counts nothing for a failure that came home before the room was looking", async () => {
    // A batch that ended while the app was closed, or days ago: whatever the
    // list carries, the room was not there, and what the count stands for is
    // the room's own news.
    const held = short(job());
    serving({ "/api/v1/projects/current/story/jobs": [held] });
    await useStoryJobStore.getState().load(ids.story);

    expect(useStoryJobStore.getState().jobs).toHaveLength(1);
    // The record is still held: the room reads what happened, and asking
    // again for the piece is planned from the list.
    expect(
      stepFailure(useStoryJobStore.getState().jobs, ids.story, "storyboard"),
    ).toEqual({ failed: 1, jobId: "job-1", reasons: ["the provider refused"] });
    // The badge is not the list.
    expect(badge()).toBeNull();
  });

  it("starts the count over when the room takes up the story again", async () => {
    const out = job();
    serving({ "/api/v1/projects/current/story/jobs": [out] });
    await useStoryJobStore.getState().load(ids.story);
    serving({ "/api/v1/projects/current/story/jobs": [short(out)] });
    await vi.advanceTimersByTimeAsync(1600);
    expect(badge()).not.toBeNull();

    // The project is put down and opened again: the record is read as one
    // whose answer the story has had for a while, and the count begins from
    // what is happening now, which is nothing.
    useStoryJobStore.getState().reset();
    serving({
      "/api/v1/projects/current/story/jobs": [
        { ...short(out), readAt: "2026-01-02T00:00:00Z" },
      ],
    });
    await useStoryJobStore.getState().load(ids.story);

    expect(badge()).toBeNull();
  });

  it("stops counting a piece a batch this room asked for answered", async () => {
    const out = job();
    serving({ "/api/v1/projects/current/story/jobs": [out] });
    await useStoryJobStore.getState().load(ids.story);
    serving({ "/api/v1/projects/current/story/jobs": [short(out)] });
    await vi.advanceTimersByTimeAsync(1600);
    expect(badge()).not.toBeNull();

    // The reader asks again, and this time the piece comes home: the count is
    // of pieces the story is short of, and it has this one.
    serving({
      "/api/v1/projects/current/story/jobs": {
        ...answered(),
        id: "job-2",
        createdAt: "2026-01-03T00:00:00Z",
      },
    });
    await useStoryJobStore.getState().start(ids.story, "keyframeArt", []);

    expect(badge()).toBeNull();
  });
});
