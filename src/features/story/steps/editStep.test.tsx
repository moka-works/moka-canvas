// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import type { MokaFile } from "../../../shared/domain";
import { buildStoryMokaFile } from "../../../shared/domain/fixtures";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useAppStore } from "../../editor/stores/appStore";
import { useClipStore } from "../../clip/stores/clipStore";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { undo } from "../../editor/commands/execute";
import { StoryPage } from "../StoryPage";
import { useSavePathStore } from "../../editor/launcher/savePathStore";
import { useStoryExportStore } from "../stores/storyExportStore";
import { useStoryStore } from "../stores/storyStore";

const T0 = "2026-01-01T00:00:00.000Z";

/** What the render the test started answers with, as it is polled. */
let renders: Array<{
  id: string;
  timelineId: string;
  status: string;
  progress01: number;
  savedTo?: string;
  message?: string;
}> = [];
/** Whether this machine can render at all. */
let canRender = true;
/** Every render the room asked for, by the timeline it was for. */
let asked: string[] = [];
/** Where each of those renders was told to write its file. */
let destinations: string[] = [];
/** What the next ask answers with, when it is refused. */
let refusal: { status: number; code: string; message: string } | null = null;
/** What the project route hands back, for the reload after a render lands. */
let reloaded: MokaFile | null = null;

/** The server under the test: capabilities, one render, and its poll. */
function serving(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const json = (payload: unknown, status = 200) =>
        Promise.resolve(
          new Response(JSON.stringify(payload), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
        );
      if (url.includes("/story/jobs")) {
        return json([]);
      }
      if (url.includes("/clip/capabilities")) {
        return json(
          canRender
            ? { available: true, version: "9.0", transitions: [], ass: true }
            : {
                available: false,
                transitions: [],
                ass: false,
                reason: "no ffmpeg",
              },
        );
      }
      if (url.includes("/clip/export")) {
        const one = /\/clip\/export\/([^/?]+)/.exec(url);
        if (one !== null) {
          const found = renders.find((task) => task.id === one[1]);
          if (found === undefined) return json({ code: "NOT_FOUND" }, 404);
          if (method === "DELETE") {
            found.status = "cancelled";
          }
          return json(found);
        }
        if (method === "POST") {
          if (refusal !== null) {
            return json(
              { code: refusal.code, message: refusal.message },
              refusal.status,
            );
          }
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            timelineId: string;
            destination: string;
          };
          asked.push(body.timelineId);
          destinations.push(body.destination);
          const task = {
            id: `render-${asked.length}`,
            timelineId: body.timelineId,
            status: "queued",
            progress01: 0,
          };
          renders = [task, ...renders];
          return json(task);
        }
      }
      if (
        url.includes("/api/v1/projects/current") &&
        !url.includes("/commands")
      ) {
        return json({
          root: "/tmp/moka-edit-test",
          moka: reloaded ?? useProjectStore.getState().moka,
          selfCheck: { ok: true, issues: [] },
        });
      }
      return json({});
    }),
  );
}

/** The fixture's telling, which has one filmed act and one empty episode. */
function filmed(): MokaFile {
  return buildStoryMokaFile();
}

/** A recording on the shelf, measured as the test says. */
function voice(id: string, durationMs: number) {
  return {
    id,
    name: `${id}.mp3`,
    path: `assets/voice/${id}.mp3`,
    mime: "audio/mpeg",
    createdAt: T0,
    updatedAt: T0,
    probe: {
      mime: "audio/mpeg",
      bytes: 2_048,
      sha256: "1".repeat(64),
      durationMs,
    },
  };
}

/**
 * The room as a reader reaches step five: the telling is open, the step is
 * stood on, and the project's own route answers with what it holds.
 */
function openAtEdit(moka: MokaFile): void {
  reloaded = moka;
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-edit-test",
    selfCheck: { ok: true, issues: [] },
  });
  useStoryStore.getState().adopt(moka);
  render(<StoryPage />);
  act(() => useStoryStore.getState().goStep("edit"));
}

function story() {
  const held = useProjectStore.getState().moka?.stories?.[0];
  if (held === undefined) throw new Error("a story is open");
  return held;
}

function timelines() {
  return useProjectStore.getState().moka?.timelines ?? [];
}

beforeEach(() => {
  renders = [];
  asked = [];
  destinations = [];
  refusal = null;
  reloaded = null;
  canRender = true;
  serving();
  localStorage.clear();
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useStoryStore.getState().forget();
  useStoryExportStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("assembling a telling", () => {
  it("lays its clips on the timeline it was given, and steps back in one undo", async () => {
    openAtEdit(filmed());
    const before = timelines()[timelines().length - 1]!;
    const clipsBefore = before.clips.length;
    expect(screen.getByTestId("story-assembly-summary").textContent).toContain(
      "1",
    );

    fireEvent.click(screen.getByTestId("story-film-reassemble"));
    await waitFor(() =>
      expect(timelines()[timelines().length - 1]!.clips.length).toBeGreaterThan(
        clipsBefore,
      ),
    );
    const after = timelines()[timelines().length - 1]!;
    // The telling's own clip was taken back; the reader's other clips stay.
    expect(after.clips.map((clip) => clip.id)).not.toContain(
      before.clips[0]!.id,
    );
    expect(after.clips.some((clip) => clip.kind === "video")).toBe(true);
    expect(after.clips.some((clip) => clip.kind === "text")).toBe(true);
    expect(story().edit.timelineId).toBe(after.id);
    expect(after.settings).toMatchObject({ width: 1920, height: 1080 });
    expect(after.clips.filter((clip) => clip.kind === "video")).toHaveLength(1);

    // One undo takes back the clips and the story's memory of them at once.
    act(() => {
      undo();
    });
    await waitFor(() =>
      expect(timelines()[timelines().length - 1]!.clips).toHaveLength(
        clipsBefore,
      ),
    );
    expect(story().edit.clipByAct?.[0]?.clipId).toBe(before.clips[0]!.id);
  });

  it("says which act is missing a clip, and walks to it", async () => {
    const moka = filmed();
    const second = moka.stories![0].chapters[1]!;
    moka.stories![0].chapters[1] = {
      ...second,
      acts: [{ ...moka.stories![0].chapters[0]!.acts[0]!, id: "act-2" }],
    };
    const held = moka.stories![0].chapters[1]!.acts[0]!;
    held.video = { takes: [] };
    openAtEdit(moka);

    const warnings = screen.getByTestId("story-assembly-warnings");
    expect(warnings.textContent).toContain("Episode 2");
    fireEvent.click(screen.getByTestId("story-warning-go-0"));
    expect(useStoryStore.getState().step).toBe("storyboard");
    expect(useStoryStore.getState().openChapterId).toBe(second.id);
  });

  it("keeps its clips off a timeline of the reader's, and says so first", async () => {
    openAtEdit(filmed());
    fireEvent.click(screen.getByTestId("story-film-reassemble"));
    await waitFor(() => expect(story().edit.timelineId).toBeDefined());
    const timeline = timelines()[timelines().length - 1]!;
    // The reader adds a clip of their own to the same timeline.
    act(() => {
      useProjectStore.getState().applyLocal([
        {
          type: "addClips",
          timelineId: timeline.id,
          clips: [
            { ...timeline.clips[0]!, id: "clip-by-hand", startMs: 60_000 },
          ],
        },
      ]);
    });

    fireEvent.click(screen.getByTestId("story-film-reassemble"));
    const question = screen.getByTestId("rebuild-timeline");
    expect(question.textContent).toContain("1");
    fireEvent.click(screen.getByTestId("rebuild-timeline-cancel"));
    await waitFor(() =>
      expect(
        timelines()[timelines().length - 1]!.clips.some(
          (clip) => clip.id === "clip-by-hand",
        ),
      ).toBe(true),
    );
  });

  it("says the save is blocked, and why, rather than that it is still saving", async () => {
    openAtEdit(filmed());
    useAppStore.setState({ toasts: [] });
    // A write the server will not take: what is waiting stays in this window,
    // and a reader told "still saving" would wait for a save that is not
    // coming. What is said is the reason the write gave.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const json = (payload: unknown, status = 200) =>
          Promise.resolve(
            new Response(JSON.stringify(payload), {
              status,
              headers: { "Content-Type": "application/json" },
            }),
          );
        if (init?.method === "POST" && url.includes("/commands")) {
          return json(
            { code: "INTERNAL", message: "io error: disk full" },
            500,
          );
        }
        if (url.includes("/api/v1/projects/current")) {
          return json({
            root: "/tmp/moka-edit-test",
            moka: useProjectStore.getState().moka,
            selfCheck: { ok: true, issues: [] },
          });
        }
        return json([]);
      }),
    );

    act(() => {
      // A change of the reader's that says nothing new: what the case needs is
      // something waiting to be written, not a different document.
      useProjectStore.getState().applyLocal([
        {
          type: "setStoryEdit",
          storyId: story().id,
          patch: { timelineId: story().edit.timelineId ?? null },
        },
      ]);
    });
    await act(async () => {
      await useProjectStore.getState().flush();
    });
    expect(useProjectStore.getState().saveStatus).toBe("error");
    const before = story().edit;

    fireEvent.click(screen.getByTestId("story-film-reassemble"));

    await waitFor(() => {
      const said = useAppStore.getState().toasts.at(-1);
      expect(said?.message).toBe("io error: disk full");
    });
    // The reason leads; "still saving" is kept under it, where it is what is
    // left to say rather than the whole of it.
    expect(useAppStore.getState().toasts.at(-1)?.detail).toBe(
      "Changes are still being saved — try again in a moment",
    );
    // Nothing was laid down: an assembly against a document the server does
    // not hold would rest on a revision it has moved past.
    expect(story().edit).toEqual(before);
  });

  it("writes the lines of the telling as captions when asked to", async () => {
    openAtEdit(filmed());
    expect(
      (screen.getByTestId("story-assembly-subtitles") as HTMLInputElement)
        .checked,
    ).toBe(true);
    fireEvent.click(screen.getByTestId("story-film-reassemble"));
    await waitFor(() => expect(story().edit.timelineId).toBeDefined());
    const timeline = timelines()[timelines().length - 1]!;
    const captions = timeline.clips.filter((clip) => clip.kind === "text");
    expect(captions).toHaveLength(1);
    expect(captions[0]?.text?.content).toContain("车已经停运了。");
  });
});

describe("the film of a telling", () => {
  it("asks where the film goes, renders the timeline, and says where it landed", async () => {
    openAtEdit(filmed());
    fireEvent.click(screen.getByTestId("story-film-reassemble"));
    await waitFor(() => expect(story().edit.timelineId).toBeDefined());

    fireEvent.click(screen.getByTestId("story-film-export"));
    // The path is a question before the render is, and a back-out means no
    // render at all.
    await waitFor(() =>
      expect(useSavePathStore.getState().pending).not.toBeNull(),
    );
    expect(useSavePathStore.getState().pending?.title).toBe("Save the film");
    expect(asked).toHaveLength(0);
    useSavePathStore.getState().reply("/tmp/moka-edit-test/films/the film.mp4");

    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toBe(story().edit.timelineId);
    expect(destinations[0]).toBe("/tmp/moka-edit-test/films/the film.mp4");

    // The render comes home as a file of the reader's own: the card says where
    // it is, and the telling is not rewritten to hold it.
    renders = [
      {
        ...renders[0]!,
        status: "done",
        progress01: 1,
        savedTo: "/tmp/moka-edit-test/films/the film.mp4",
      },
    ];
    useAppStore.setState({ toasts: [] });
    await act(async () => {
      await useStoryExportStore.getState().setTask(renders[0]! as never);
    });
    await waitFor(() =>
      expect(screen.getByTestId("story-film-saved").textContent).toContain(
        "/tmp/moka-edit-test/films/the film.mp4",
      ),
    );
    const said = useAppStore.getState().toasts.at(-1);
    expect(said?.message).toBe(
      "The film is saved to /tmp/moka-edit-test/films/the film.mp4",
    );
    expect(said?.choice?.label).toBe("Open in the cutting room");
  });

  it("leaves the project untouched when a render lands", async () => {
    openAtEdit(filmed());
    fireEvent.click(screen.getByTestId("story-film-reassemble"));
    await waitFor(() => expect(story().edit.timelineId).toBeDefined());

    fireEvent.click(screen.getByTestId("story-film-export"));
    await waitFor(() =>
      expect(useSavePathStore.getState().pending).not.toBeNull(),
    );
    useSavePathStore.getState().reply("/tmp/moka-edit-test/films/the film.mp4");
    await waitFor(() => expect(asked).toHaveLength(1));

    // A change of the reader's, still waiting to be written down.
    act(() => {
      useProjectStore.getState().applyLocal([
        {
          type: "setStoryEdit",
          storyId: story().id,
          patch: { timelineId: story().edit.timelineId ?? null },
        },
      ]);
    });
    const waiting = useProjectStore.getState().pending.length;
    expect(waiting).toBeGreaterThan(0);

    renders = [
      {
        ...renders[0]!,
        status: "done",
        progress01: 1,
        savedTo: "/tmp/moka-edit-test/films/the film.mp4",
      },
    ];
    useAppStore.setState({ toasts: [] });
    await act(async () => {
      await useStoryExportStore.getState().setTask(renders[0]! as never);
    });

    // Landing a file reads and writes nothing of the project, so a change the
    // server has not taken yet is not in the way of it.
    await waitFor(() =>
      expect(useAppStore.getState().toasts.at(-1)?.message).toBe(
        "The film is saved to /tmp/moka-edit-test/films/the film.mp4",
      ),
    );
    expect(useProjectStore.getState().pending.length).toBe(waiting);
  });

  it("says a machine without a renderer cannot render, rather than failing", async () => {
    canRender = false;
    openAtEdit(filmed());
    const button = screen.getByTestId("story-film-export") as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.getAttribute("title")).toContain("ffmpeg");
    // Said in words on the card as well: a reason that only a hover reveals
    // is a reason most readers never read.
    await waitFor(() =>
      expect(screen.getByTestId("story-film-capability").textContent).toContain(
        "no ffmpeg",
      ),
    );
  });

  it("opens the assembled timeline in the cutting room", async () => {
    openAtEdit(filmed());
    fireEvent.click(screen.getByTestId("story-film-reassemble"));
    await waitFor(() => expect(story().edit.timelineId).toBeDefined());

    fireEvent.click(screen.getByTestId("story-film-open"));
    await waitFor(() => expect(useAppStore.getState().phase).toBe("clip"));
    expect(useClipStore.getState().activeTimelineId).toBe(
      story().edit.timelineId,
    );
  });

  it("has nothing to confirm, and one link that lays the clips out", async () => {
    openAtEdit(filmed());
    // The step is the assembly: there is no confirm button to press, and the
    // card's link is the only way the clips are laid down.
    expect(screen.queryByTestId("story-confirm-edit")).toBeNull();
    expect(screen.queryByTestId("story-assemble")).toBeNull();

    fireEvent.click(screen.getByTestId("story-film-reassemble"));
    await waitFor(() => expect(story().edit.timelineId).toBeDefined());
  });

  it("says why the clips cannot be laid out when none is filmed", async () => {
    const moka = filmed();
    const acts = moka.stories![0].chapters[0]!.acts;
    for (const act of acts) {
      act.video = { takes: [] };
      for (const keyframe of act.keyframes) keyframe.video = { takes: [] };
    }
    openAtEdit(moka);

    const link = screen.getByTestId("story-film-reassemble");
    expect(link).toHaveProperty("disabled", true);
    expect(link.getAttribute("title")).toContain("No clip has been filmed");
  });
});

describe("a film that has fallen behind the telling", () => {
  it("says so, and assembles before rendering rather than after", async () => {
    openAtEdit(filmed());
    // Nothing has been assembled at all, so the film is behind by definition —
    // and the export is the press that fixes it rather than one that refuses.
    expect(screen.getByTestId("story-film-freshness").textContent).toContain(
      "behind the telling",
    );
    const button = screen.getByTestId("story-film-export");
    expect(button.textContent).toContain("assemble first");
    // The card reads the machine before it offers anything, and this machine
    // can render: the one thing standing between the reader and a film is the
    // assembly the export itself makes.
    await waitFor(() => expect(button).toHaveProperty("disabled", false));

    fireEvent.click(button);
    await waitFor(() =>
      expect(useSavePathStore.getState().pending).not.toBeNull(),
    );
    useSavePathStore.getState().reply("/tmp/moka-edit-test/films/the film.mp4");
    await waitFor(() => expect(asked).toHaveLength(1));
    // What was rendered is the timeline the export itself laid down, which is
    // the telling as it stands rather than a film of an older one.
    expect(story().edit.timelineId).toBeDefined();
    expect(asked[0]).toBe(story().edit.timelineId);
    expect(
      timelines()
        .find((held) => held.id === asked[0])
        ?.clips.some((clip) => clip.kind === "video"),
    ).toBe(true);
  });

  it("says what it carries, and stays fresh once it is assembled", async () => {
    const moka = filmed();
    moka.resources.voice = [
      voice("asset-said", 1_200),
      voice("asset-said-again", 2_400),
    ];
    const frame = moka.stories![0].chapters[0]!.acts[0]!.keyframes[0]!;
    frame.voices = [
      {
        lineId: "line-1",
        text: "车已经停运了。",
        voice: "",
        slot: { takes: [{ assetIds: ["asset-said"], createdAt: T0 }] },
      },
    ];
    openAtEdit(moka);

    // What the film will carry, counted before it is made.
    expect(screen.getByTestId("story-film-carries").textContent).toContain(
      "1 readings",
    );
    expect(screen.getByTestId("story-film-carries").textContent).toContain(
      "subtitles on",
    );

    fireEvent.click(screen.getByTestId("story-film-reassemble"));
    await waitFor(() => expect(story().edit.timelineId).toBeDefined());
    await waitFor(() =>
      expect(screen.getByTestId("story-film-freshness").textContent).toContain(
        "the telling as it stands",
      ),
    );

    // The telling moves on — a line re-read — and the film is behind again.
    act(() => {
      useProjectStore.getState().applyLocal([
        {
          type: "setStorySlot",
          storyId: story().id,
          target: {
            kind: "lineVoice",
            chapterId: "chapter-first",
            actId: "act-1",
            keyframeId: "frame-1",
            lineId: "line-1",
          },
          slot: {
            takes: [
              {
                assetIds: ["asset-said-again"],
                createdAt: "2026-01-02T00:00:00Z",
              },
            ],
          },
        },
      ]);
    });
    await waitFor(() =>
      expect(screen.getByTestId("story-film-freshness").textContent).toContain(
        "behind the telling",
      ),
    );
  });

  it("says an assembly that cannot be made rather than rendering the older film", async () => {
    openAtEdit(filmed());
    // The material leaves the project: the telling can no longer be laid down,
    // and a render of what is on the timeline would be a film of a telling
    // that is not there any more.
    const held = story();
    held.chapters[0]!.acts[0]!.video = {
      takes: [{ assetIds: ["asset-gone"], createdAt: T0 }],
    };

    const button = screen.getByTestId("story-film-export");
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);
    await waitFor(() =>
      expect(useSavePathStore.getState().pending).not.toBeNull(),
    );
    useSavePathStore.getState().reply("/tmp/moka-edit-test/films/the film.mp4");
    // The assembly is refused with what is wrong, and nothing is rendered: no
    // film is better than the wrong one.
    await waitFor(() =>
      expect(screen.getByTestId("story-film-error").textContent).toContain(
        "No clip has been filmed",
      ),
    );
    expect(asked).toHaveLength(0);
  });
});
