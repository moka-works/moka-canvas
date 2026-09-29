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

import type {
  StoryJobItemDraft,
  StoryJobKind,
  StoryJobRecord,
} from "../../../api/story";
import type { MokaFile } from "../../../shared/domain";
import { createChapter } from "../../../shared/domain/factories";
import {
  buildEmptyStory,
  buildStoryMokaFile,
  storyIds,
} from "../../../shared/domain/fixtures";
import { undo } from "../../editor/commands/execute";
import { useAppStore } from "../../editor/stores/appStore";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useModelStore } from "../../settings/modelStore";
import { StoryPage } from "../StoryPage";
import { useStoryJobStore } from "../stores/storyJobStore";
import { useStoryStore } from "../stores/storyStore";

const ids = storyIds();

/** What the room handed the server, in the order it handed it over. */
let starts: Array<{ kind: StoryJobKind; items: StoryJobItemDraft[] }> = [];
/** The batches the server is holding, newest first. */
let held: StoryJobRecord[] = [];
/** What each piece of the next batch is answered with, by the piece's id. */
let answers: Record<string, string> = {};
/** The manuscript the shelf answers with. */
let manuscript = "";

/**
 * The server under the test: the project as it stands, the batches the room
 * starts, and the answers they come home with.
 *
 * A batch is answered when it is asked about on its own, which is what a poll
 * and a room coming back to a batch both do. The project route answers with
 * the document the room already holds, since reading it again between two
 * commands must not be what a test notices.
 */
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
        // A batch's answer being written down as read: the record as it stands
        // with the room's note on it, which is what the server answers with.
        const readIn = /\/story\/jobs\/([^/?]+)\/read$/.exec(url);
        if (readIn !== null) {
          const found = held.find((job) => job.id === readIn[1]);
          const marked =
            found === undefined
              ? undefined
              : { ...found, readAt: "2026-01-02T00:00:00Z" };
          if (marked !== undefined) {
            held = held.map((job) => (job.id === marked.id ? marked : job));
          }
          return marked === undefined
            ? json({ code: "NOT_FOUND", message: "no" }, 404)
            : json(marked);
        }
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            kind: StoryJobKind;
            items: StoryJobItemDraft[];
          };
          starts.push({ kind: body.kind, items: body.items });
          const record = batchOf(starts.length, body.kind, body.items);
          held = [record, ...held];
          return json(record);
        }
        const one = /\/story\/jobs\/([^/?]+)/.exec(url);
        if (one !== null) {
          const found = held.find((job) => job.id === one[1]);
          if (found === undefined) {
            return json({ code: "NOT_FOUND", message: "no" }, 404);
          }
          const home = answered(found);
          held = [home, ...held.filter((job) => job.id !== found.id)];
          return json(home);
        }
        return json(held);
      }
      if (url.includes("/assets/")) {
        return Promise.resolve(new Response(manuscript));
      }
      if (url.includes("/api/v1/projects/current")) {
        return json({
          root: "/tmp/moka-outline-test",
          moka: useProjectStore.getState().moka,
          selfCheck: { ok: true, issues: [] },
          selfCheckVerified: true,
        });
      }
      return json({});
    }),
  );
}

/** A batch as it is handed over: every piece still going. */
function batchOf(
  number: number,
  kind: StoryJobKind,
  items: StoryJobItemDraft[],
): StoryJobRecord {
  return {
    id: `job-${number}`,
    projectId: "project-1",
    storyId: useProjectStore.getState().moka?.stories?.[0]?.id ?? ids.story,
    kind,
    status: "running",
    model: "a-storyteller",
    items: items.map((item) => ({
      ...item,
      inputs: item.inputs ?? [],
      params: item.params ?? {},
      status: "running",
    })),
    cancelRequested: false,
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
  };
}

/** The same batch as it comes home, every piece answered as the test said. */
function answered(record: StoryJobRecord): StoryJobRecord {
  return {
    ...record,
    status: "succeeded",
    items: record.items.map((item) => ({
      ...item,
      status: "succeeded" as const,
      ...(answers[item.id] !== undefined ? { text: answers[item.id] } : {}),
    })),
  };
}

/** The batch the room started last, coming home with its answers. */
async function comesBack(): Promise<void> {
  const found = held.find((job) => job.id === `job-${starts.length}`);
  if (found === undefined) throw new Error("a batch was started first");
  await act(async () => {
    await useStoryJobStore.getState().adopt(found.id);
  });
}

/** A telling with a premise and no chapters: where step two begins. */
function atTheOutline(): MokaFile {
  const moka = buildEmptyStory("空故事");
  const story = moka.stories![0];
  story.brief = {
    ...story.brief,
    idea: "末班列车停在无人站台，值班员递上一张旧车票。",
    totalDurationMs: 180_000,
  };
  return moka;
}

/** A telling with two chapters, one of which has nothing written into it. */
function withChapters(): MokaFile {
  const moka = atTheOutline();
  moka.stories![0].chapters = [
    createChapter("第一章 站台", "他在站台上等车。"),
    createChapter("第二章 车厢"),
  ];
  return moka;
}

/** The same telling with a manuscript on the shelf. */
function withManuscript(chapterCount: number): MokaFile {
  const moka = atTheOutline();
  const story = moka.stories![0];
  story.brief = {
    ...story.brief,
    sourceAssetId: "asset-novel",
    sourceName: "novel.txt",
  };
  manuscript = Array.from(
    { length: chapterCount },
    (_, index) =>
      `第${index + 1}章 站台\n他在站台上等一班已经停运的列车，风把雨吹成斜的。`,
  ).join("\n");
  return moka;
}

/**
 * The fixture with its board standing on the second chapter, which is where a
 * telling divided into fewer chapters than it has would leave it behind.
 */
function withTheBoardLast(): MokaFile {
  const moka = buildStoryMokaFile();
  const chapters = moka.stories![0].chapters;
  chapters[1]!.acts = chapters[0]!.acts;
  chapters[0]!.acts = [];
  return moka;
}

function openRoom(moka: MokaFile): void {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-outline-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  useStoryStore.getState().adopt(moka);
  render(<StoryPage />);
}

/** The room as a reader reaches step two: the page, standing on the outline. */
function openAtOutline(moka: MokaFile): void {
  openRoom(moka);
  if (useStoryStore.getState().step === "idea") {
    // Step two opens on a premise the reader has settled, the way it does for
    // a telling that has only been named.
    const box = screen.getByTestId("story-idea-input") as HTMLTextAreaElement;
    if (box.value.trim() === "") {
      fireEvent.change(box, {
        target: { value: "末班列车上，两个陌生人交换了各自要说的话。" },
      });
    }
    fireEvent.click(screen.getByTestId("story-confirm-idea"));
    return;
  }
  fireEvent.click(screen.getByTestId("story-step-outline"));
}

function story() {
  const held = useProjectStore.getState().moka?.stories?.[0];
  if (held === undefined) throw new Error("a story is open");
  return held;
}

function chapters() {
  return story().chapters;
}

function field(testId: string): HTMLInputElement {
  return screen.getByTestId(testId) as HTMLInputElement;
}

/** The answers an outline ask is given, in the shape a model answers in. */
function chaptersAnswer(...titles: string[]): string {
  return JSON.stringify({
    chapters: titles.map((title) => ({
      title,
      synopsis: `${title} 里发生的事。`,
    })),
  });
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * A deployment whose story room is set to cut the manuscript at a length.
 *
 * The boundary is the reader's, since how much of a telling a model can hold is
 * a property of the model: what a test sets here is what the room reads when it
 * plans a batch.
 */
function cuttingAt(splitChars: number): void {
  useModelStore.setState({
    view: {
      version: 1,
      revision: 1,
      models: [],
      defaults: {
        text: null,
        image: null,
        speech: null,
        music: null,
        video: null,
        asr: null,
      },
      preferences: {
        systemPrompt: "",
        reasoningEffort: "auto",
        image: { size: "1:1", quality: "auto", background: "", count: 1 },
        video: {
          seconds: 6,
          resolution: "720",
          generateAudio: true,
          watermark: false,
          mode: "auto",
          ratio: "",
        },
        speech: {
          voice: "",
          format: "mp3",
          speed: 1,
          instructions: "",
          sampleRate: 22050,
          volume: 50,
          rate: 1,
          pitch: 1,
        },
        music: { format: "mp3", watermark: false },
        story: { splitChars, readChars: 8_000 },
      },
      secretStorage: "unset",
    },
  });
}

beforeEach(() => {
  starts = [];
  held = [];
  answers = {};
  manuscript = "";
  useModelStore.setState({ view: null });
  serving();
  localStorage.clear();
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useStoryStore.getState().forget();
  useStoryJobStore.getState().reset();
  useAppStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("writing a premise into chapters", () => {
  it("asks for the chapters the reader counted, and writes them into the story", async () => {
    openAtOutline(atTheOutline());
    answers.outline = chaptersAnswer("站台", "车厢", "天亮");

    fireEvent.change(field("story-outline-chapters"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByTestId("story-outline-start"));

    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    const ask = starts[0];
    expect(ask?.kind).toBe("outline");
    expect(ask?.items).toHaveLength(1);
    expect(ask?.items[0]?.prompt).toContain("3 chapters");
    expect(ask?.items[0]?.prompt).toContain("末班列车停在无人站台");

    await comesBack();
    await waitFor(() => {
      expect(chapters()).toHaveLength(3);
    });
    expect(chapters().map((chapter) => chapter.title)).toEqual([
      "站台",
      "车厢",
      "天亮",
    ]);
    // Every chapter is given a running time to be boarded against, since the
    // model was not asked for one.
    expect(chapters()[0]?.targetDurationMs).toBe(60_000);
  });

  it("settles the outline once every chapter is written, and says what is missing otherwise", () => {
    openAtOutline(withChapters());
    expect(chapters()).toHaveLength(2);

    fireEvent.click(screen.getByTestId("story-confirm-outline"));
    expect(
      screen.getByTestId("story-confirm-gaps-outline").textContent,
    ).toContain("1 chapters still have no title or synopsis (chapter 2)");
    expect(story().confirmedSteps).not.toContain("outline");

    // Written through, and the press settles it as one step of the history.
    fireEvent.change(screen.getByTestId("story-chapter-synopsis-1"), {
      target: { value: "车厢里只有两个人。" },
    });
    fireEvent.blur(screen.getByTestId("story-chapter-synopsis-1"));
    fireEvent.click(screen.getByTestId("story-confirm-outline"));

    expect(screen.queryByTestId("story-confirm-gaps-outline")).toBeNull();
    expect(story().confirmedSteps).toContain("outline");

    act(() => {
      undo();
    });
    expect(story().confirmedSteps).not.toContain("outline");
  });

  it("writes the words of a chapter when the reader looks away from them", () => {
    openAtOutline(buildStoryMokaFile());

    const synopsis = screen.getByTestId(
      "story-chapter-synopsis-0",
    ) as HTMLTextAreaElement;
    fireEvent.change(synopsis, { target: { value: "他在站台上等到天亮。" } });
    expect(chapters()[0]?.synopsis).not.toContain("等到天亮");

    fireEvent.blur(synopsis);
    expect(chapters()[0]?.synopsis).toBe("他在站台上等到天亮。");
  });

  it("asks for nothing at all while the reader is only counting", () => {
    openAtOutline(atTheOutline());

    fireEvent.change(field("story-outline-chapters"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByTestId("story-outline-chapters"));
    expect(starts).toHaveLength(0);
    expect(screen.getByTestId("story-outline-will-ask").textContent).toContain(
      "7",
    );
  });
});

describe("splitting a manuscript", () => {
  it("asks for every part of it, in order, with the part's own words", async () => {
    openAtOutline(withManuscript(3));
    answers["outline:1"] = JSON.stringify({
      title: "第一章 站台",
      synopsis: "他在站台上等车。",
    });
    answers["outline:2"] = JSON.stringify({
      title: "第二章 车厢",
      synopsis: "车厢里只有两个人。",
    });
    answers["outline:3"] = JSON.stringify({
      title: "第三章 天亮",
      synopsis: "天亮了，他下了车。",
    });

    fireEvent.click(screen.getByTestId("story-outline-mode-split"));
    // The manuscript writes three chapters of its own, and says so.
    await waitFor(() => {
      expect(
        screen.getByTestId("story-outline-chapters-hint").textContent,
      ).toContain("3");
    });
    expect(field("story-outline-chapters").value).toBe("3");

    fireEvent.click(screen.getByTestId("story-outline-start"));
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });

    const ask = starts[0];
    expect(ask?.items.map((item) => item.id)).toEqual([
      "outline:1",
      "outline:2",
      "outline:3",
    ]);
    expect(ask?.items[0]?.prompt).toContain("第1章 站台");
    expect(ask?.items[2]?.prompt).toContain("第3章 站台");
    // Reading the manuscript is when the document is told it was divided.
    await waitFor(() => {
      expect(story().brief.sourceSplit).toBe(true);
    });

    await comesBack();
    await waitFor(() => {
      expect(chapters()).toHaveLength(3);
    });
    expect(chapters().map((chapter) => chapter.title)).toEqual([
      "第一章 站台",
      "第二章 车厢",
      "第三章 天亮",
    ]);
  });

  it("cuts a part to the length the settings allow", async () => {
    // A telling longer than a model can hold is cut before it is asked about,
    // and how long a part may be is the reader's to set.
    cuttingAt(120);
    const moka = atTheOutline();
    const story = moka.stories![0];
    story.brief = {
      ...story.brief,
      sourceAssetId: "asset-novel",
      sourceName: "novel.txt",
    };
    const sentences = Array.from(
      { length: 30 },
      (_, index) => `第${index + 1}句，雨落在站台上。`,
    );
    manuscript = `第一章 站台\n${sentences.join("")}`;

    openAtOutline(moka);
    fireEvent.change(field("story-outline-chapters"), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByTestId("story-outline-mode-split"));
    fireEvent.click(screen.getByTestId("story-outline-start"));

    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    const asked = starts[0]?.items[0]?.prompt ?? "";
    expect(asked).toContain("第1句，雨落在站台上。");
    // The whole chapter is many times the length it was cut to: what the ask
    // carries is the part, not the manuscript.
    expect(asked).not.toContain("第20句");
  });

  it("takes a manuscript longer than one batch in waves", async () => {
    openAtOutline(withManuscript(41));
    for (let part = 1; part <= 41; part += 1) {
      answers[`outline:${part}`] = JSON.stringify({
        title: `第 ${part} 章`,
        synopsis: `第 ${part} 段里的事。`,
      });
    }

    fireEvent.click(screen.getByTestId("story-outline-mode-split"));
    await waitFor(() => {
      expect(field("story-outline-chapters").value).toBe("41");
    });
    fireEvent.click(screen.getByTestId("story-outline-start"));

    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    expect(starts[0]?.items).toHaveLength(40);
    // The second wave waits for the first to come home rather than being
    // started over the top of it.
    await sleep(20);
    expect(starts).toHaveLength(1);
    expect(screen.getByTestId("story-outline-wave").textContent).toBe(
      "Batch 1 of 2",
    );

    await comesBack();
    await waitFor(() => {
      expect(starts).toHaveLength(2);
    });
    expect(starts[1]?.items).toHaveLength(1);
    expect(screen.getByTestId("story-outline-wave").textContent).toBe(
      "Batch 2 of 2",
    );
  });
});

describe("splitting again", () => {
  it("says what it costs before it writes over a board, and does nothing if refused", () => {
    openAtOutline(withTheBoardLast());
    fireEvent.change(field("story-outline-chapters"), {
      target: { value: "1" },
    });

    fireEvent.click(screen.getByTestId("story-outline-start"));
    const asked = screen.getByTestId("resplit-story");
    expect(asked.textContent).toContain("2 chapters");
    expect(asked.textContent).toContain("1 acts");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("resplit-story")).toBeNull();
    expect(starts).toHaveLength(0);
    // The board is where it was: refusing the question changed nothing.
    expect(chapters()[1]?.acts).toHaveLength(1);
  });

  it("goes ahead when the reader agrees", async () => {
    openAtOutline(buildStoryMokaFile());
    answers.outline = chaptersAnswer("站台", "车厢");

    fireEvent.click(screen.getByTestId("story-outline-start"));
    fireEvent.click(screen.getByTestId("resplit-story-confirm"));

    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    // A split keeps what was made for a chapter that stands where it stood:
    // the act of the first chapter is still there after the re-write.
    await comesBack();
    await waitFor(() => {
      expect(chapters()).toHaveLength(2);
    });
    expect(chapters()[0]?.acts).toHaveLength(1);
  });
});

describe("what the table waits on", () => {
  /** A telling split into two chapters, whose parts have come home. */
  async function twoChaptersWritten(): Promise<void> {
    openAtOutline(withManuscript(2));
    answers["outline:1"] = JSON.stringify({
      title: "第一章 站台",
      synopsis: "他在站台上等车。",
    });
    answers["outline:2"] = JSON.stringify({
      title: "第二章 车厢",
      synopsis: "车厢里只有两个人。",
    });
    fireEvent.click(screen.getByTestId("story-outline-mode-split"));
    await waitFor(() =>
      expect(field("story-outline-chapters").value).toBe("2"),
    );
    fireEvent.click(screen.getByTestId("story-outline-start"));
    await waitFor(() => expect(starts).toHaveLength(1));
    await comesBack();
    await waitFor(() => expect(chapters()).toHaveLength(2));
  }

  /** A batch of drawings out for the story, which step two knows nothing of. */
  async function drawingElsewhere(): Promise<void> {
    await act(async () => {
      await useStoryJobStore.getState().start(story().id, "keyframeArt", [
        {
          id: `keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`,
          target: {
            kind: "keyframeArt",
            chapterId: ids.chapterFirst,
            actId: ids.act,
            keyframeId: ids.frameFirst,
          },
          capability: "image",
          prompt: "雨中的站台。",
        },
      ]);
    });
  }

  it("is not held back by a batch of drawings", async () => {
    await twoChaptersWritten();
    await drawingElsewhere();

    // The buttons belong to the table: pictures being painted for a board are
    // not a chapter being written, and do not shut the step.
    expect(
      (screen.getByTestId("story-outline-start") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByTestId("story-confirm-outline")).toBeTruthy();
    expect(
      (screen.getByTestId("story-chapter-redo-0") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByTestId("story-chapter-redo-1") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    // And the button the step is asked through still says what it would do
    // rather than counting a batch that has nothing to do with the table.
    expect(screen.getByTestId("story-outline-start").textContent).toBe(
      "Split it again",
    );
  });

  it("waits on one chapter at a time, and not on the chapter beside it", async () => {
    await twoChaptersWritten();
    fireEvent.click(screen.getByTestId("story-chapter-redo-0"));
    await waitFor(() => expect(starts).toHaveLength(2));

    // The chapter being written again waits on its own ask...
    expect(
      (screen.getByTestId("story-chapter-redo-0") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // ...while the chapter beside it is still one the reader can ask for.
    expect(
      (screen.getByTestId("story-chapter-redo-1") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe("an answer nobody could read", () => {
  it("says so, and takes a repaired answer by hand", async () => {
    openAtOutline(atTheOutline());
    answers.outline = "I am afraid I cannot help with that.";

    fireEvent.click(screen.getByTestId("story-outline-start"));
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    await comesBack();
    expect(chapters()).toHaveLength(0);
    expect(screen.getByTestId("story-outline-empty")).toBeTruthy();

    fireEvent.click(screen.getByTestId("story-outline-answer-toggle"));
    // The answer is kept as it came, with what the reading made of it.
    expect(
      screen.getByTestId("story-outline-answer-error").textContent,
    ).toContain("chapter table");
    fireEvent.click(screen.getByTestId("story-outline-answer-fix"));
    const edit = screen.getByTestId(
      "story-outline-answer-edit",
    ) as HTMLTextAreaElement;
    expect(edit.value).toBe("I am afraid I cannot help with that.");
    fireEvent.change(edit, {
      target: { value: chaptersAnswer("站台", "车厢") },
    });
    fireEvent.click(screen.getByTestId("story-outline-answer-apply"));

    await waitFor(() => {
      expect(chapters().map((chapter) => chapter.title)).toEqual([
        "站台",
        "车厢",
      ]);
    });
  });
});
