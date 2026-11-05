// @vitest-environment jsdom
import { resetUiPrefs } from "../../../shared/prefs/prefsData";
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
import { isSourceHeading } from "../../../shared/domain/storySource";
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
import { chapterText } from "../readText";
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

/** The manuscript a split prompt carries, between its own marks. */
function windowOf(prompt: string): string {
  const open = prompt.indexOf("---\n");
  const close = prompt.lastIndexOf("\n---");
  return open < 0 || close < 0 ? "" : prompt.slice(open + 4, close);
}

/** The headings in a window, with the offset each stands at. */
function headingsOf(text: string): Array<{ title: string; start: number }> {
  const found: Array<{ title: string; start: number }> = [];
  let at = 0;
  for (const line of text.split("\n")) {
    if (isSourceHeading(line)) {
      found.push({ title: line.trim(), start: at });
    }
    at += line.length + 1;
  }
  return found;
}

/** The paragraphs in a window, with the offset each stands at. */
function paragraphsOf(text: string): Array<{ title: string; start: number }> {
  const found: Array<{ title: string; start: number }> = [];
  let at = 0;
  for (const part of text.split("\n\n")) {
    const title = part.split("\n")[0]?.trim() ?? "";
    if (title !== "") found.push({ title, start: at });
    at += part.length + 2;
  }
  return found;
}

/**
 * What a stand-in model answers a split ask with.
 *
 * The boundaries are read off the window it was given: headings when the
 * manuscript writes them, paragraphs otherwise. What the suite proves is that
 * the answer's quotations are found, the text between them is kept, and a
 * window's unfinished tail moves into the next ask rather than being cut.
 */
function splitAnswer(prompt: string): string | undefined {
  const text = windowOf(prompt);
  if (text === "") return undefined;
  const headings = headingsOf(text);
  const points = headings.length > 0 ? headings : paragraphsOf(text);
  if (points.length === 0) return undefined;
  return JSON.stringify({
    chapters: points.map((point, index) => ({
      number: index + 1,
      title: point.title,
      ...(index === 0 ? {} : { start: point.title.slice(0, 40) }),
    })),
  });
}

/** The same batch as it comes home, every piece answered as the test said. */
function answered(record: StoryJobRecord): StoryJobRecord {
  return {
    ...record,
    status: "succeeded",
    items: record.items.map((item) => {
      const split = item.id.startsWith("outline:split:");
      const text =
        answers[item.id] ?? (split ? splitAnswer(item.prompt) : undefined);
      return {
        ...item,
        status: "succeeded" as const,
        ...(text === undefined ? {} : { text }),
      };
    }),
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The batch the room started last, coming home with its answers. */
async function comesBack(): Promise<void> {
  const found = held.find((job) => job.id === `job-${starts.length}`);
  if (found === undefined) throw new Error("a batch was started first");
  await act(async () => {
    await useStoryJobStore.getState().adopt(found.id);
  });
}

/** Answers whatever batch is out, and stops when the room asks for no more. */
async function answerEveryBatch(limit = 10): Promise<void> {
  for (let n = 0; n < limit; n += 1) {
    if (starts.length <= n) {
      await waitFor(() => expect(starts.length).toBeGreaterThan(n));
    }
    const id = `job-${n + 1}`;
    if (!held.some((job) => job.id === id)) return;
    await act(async () => {
      await useStoryJobStore.getState().adopt(id);
    });
    await act(async () => {
      await sleep(10);
    });
    if (starts.length === n + 1) return;
  }
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

/** The same telling with a manuscript on the shelf that writes its own chapters. */
function withManuscript(chapterCount: number): MokaFile {
  const moka = atTheOutline();
  const story = moka.stories![0];
  story.brief = {
    ...story.brief,
    sourceAssetId: "asset-novel",
    sourceName: "novel.txt",
  };
  // The manuscript is the project's own copy, as an upload always files one:
  // a chapter's offsets point into a file the project controls.
  moka.resources.texts = [
    ...(moka.resources.texts ?? []),
    {
      id: "asset-novel",
      name: "novel.txt",
      path: "assets/texts/novel-00000000.txt",
      mime: "text/plain",
      createdAt: "2026-01-02T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    },
  ];
  manuscript = Array.from(
    { length: chapterCount },
    (_, index) =>
      `第${index + 1}章 站台\n他在站台上等一班已经停运的列车，风把雨吹成斜的。`,
  ).join("\n");
  return moka;
}

/** A manuscript of plain paragraphs, for a window that has no headings. */
function withLongManuscript(paragraphs: number): MokaFile {
  const moka = withManuscript(0);
  manuscript = Array.from(
    { length: paragraphs },
    (_, index) =>
      `第 ${index + 1} 段。${"雨落在站台上，灯一盏一盏亮起来，车迟迟没有来。".repeat(10)}`,
  ).join("\n\n");
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

/**
 * A deployment whose story room is set to cut the manuscript at a length.
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
  resetUiPrefs();
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
    expect(chapters()[0]?.targetDurationMs).toBe(60_000);
  });

  it("settles the outline once every chapter is written, and says what is missing otherwise", () => {
    openAtOutline(withChapters());
    expect(chapters()).toHaveLength(2);

    fireEvent.click(screen.getByTestId("story-confirm-outline"));
    expect(
      screen.getByTestId("story-confirm-gaps-outline").textContent,
    ).toContain("1 chapters still have no title or text (chapter 2)");
    expect(story().confirmedSteps).not.toContain("outline");

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
});

describe("splitting a manuscript", () => {
  it("cuts at the boundaries the model names, keeping the manuscript's words", async () => {
    openAtOutline(withManuscript(3));

    fireEvent.click(screen.getByTestId("story-outline-mode-split"));
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
    expect(ask?.items).toHaveLength(1);
    expect(ask?.items[0]?.id).toBe("outline:split:1");
    expect(ask?.items[0]?.prompt).toContain("第1章 站台");
    expect(ask?.items[0]?.prompt).toContain("第3章 站台");

    await comesBack();
    await waitFor(() => {
      expect(chapters()).toHaveLength(3);
    });
    expect(chapters().map((chapter) => chapter.title)).toEqual([
      "第1章 站台",
      "第2章 站台",
      "第3章 站台",
    ]);
    // The chapter is a window into the manuscript, not a copy of it, and the
    // heading it is titled with is not repeated in its text.
    expect(chapters()[0]?.source?.assetId).toBe("asset-novel");
    expect(chapters()[0]?.source?.end).toBeGreaterThan(
      chapters()[0]?.source?.start ?? 0,
    );
    expect(chapterText(chapters()[0]!)).toBe(
      "他在站台上等一班已经停运的列车，风把雨吹成斜的。",
    );
    expect(story().brief.sourceSplit).toBe(true);
  });

  it("takes a manuscript longer than one window in batches, carrying its tail", async () => {
    cuttingAt(1_000);
    openAtOutline(withLongManuscript(8));

    fireEvent.click(screen.getByTestId("story-outline-mode-split"));
    fireEvent.click(screen.getByTestId("story-outline-start"));
    await answerEveryBatch();

    await waitFor(() => expect(chapters()).toHaveLength(8));
    // Every window is a different part of the same reading, and the text is
    // cut once: no paragraph appears in two chapters.
    expect(starts.length).toBeGreaterThan(1);
    expect(starts.map((ask) => ask.items[0]?.id)).toEqual(
      starts.map((_, index) => `outline:split:${index + 1}`),
    );
    const held = chapters().map((chapter) => chapterText(chapter));
    expect(new Set(held).size).toBe(held.length);
    expect(held.join("\n").match(/第 \d 段。/g)?.length).toBe(8);
  });

  it("drops front matter the model marks as chapter zero", async () => {
    openAtOutline(withManuscript(2));
    answers["outline:split:1"] = JSON.stringify({
      chapters: [
        { number: 0, title: "目录", discard: true, start: "目录" },
        { number: 1, title: "第1章 站台", start: "第1章 站台" },
        { number: 2, title: "第2章 站台", start: "第2章 站台" },
      ],
    });
    manuscript = `目录\n第一章介绍\n第1章 站台\n他在站台上等车。\n第2章 站台\n车厢里只有两个人。`;

    fireEvent.click(screen.getByTestId("story-outline-mode-split"));
    fireEvent.click(screen.getByTestId("story-outline-start"));
    await waitFor(() => expect(starts).toHaveLength(1));
    await comesBack();
    await waitFor(() => expect(chapters()).toHaveLength(2));
    expect(chapters().map((chapter) => chapter.title)).toEqual([
      "第1章 站台",
      "第2章 站台",
    ]);
    expect(
      chapters()
        .map((chapter) => chapterText(chapter))
        .join(),
    ).not.toContain("目录");
  });

  it("says the split failed after the model keeps losing the boundaries", async () => {
    openAtOutline(withManuscript(2));
    answers["outline:split:1"] = "I am afraid I cannot help with that.";

    fireEvent.click(screen.getByTestId("story-outline-mode-split"));
    fireEvent.click(screen.getByTestId("story-outline-start"));
    await answerEveryBatch();

    await waitFor(() => {
      expect(screen.getByTestId("story-outline-error").textContent).toContain(
        "The split failed",
      );
    });
    expect(starts).toHaveLength(3);
    expect(chapters()).toHaveLength(0);
    // The raw answer is not a feature of the step any more.
    expect(screen.queryByTestId("story-outline-answer")).toBeNull();
  });
});

describe("splitting again", () => {
  it("says what it costs before it writes over a board, and does nothing if refused", () => {
    openAtOutline(withTheBoardLast());
    manuscript = "第1章 站台\n他在站台上等车。\n第2章 车厢\n车厢里只有两个人。";
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
    expect(chapters()[1]?.acts).toHaveLength(1);
  });

  it("goes ahead when the reader agrees, and keeps a chapter's board", async () => {
    openAtOutline(buildStoryMokaFile());
    manuscript =
      "第一章 站台\n他在站台上等一班已经停运的列车。\n第二章 车厢\n车厢比站台更暗。";

    fireEvent.click(screen.getByTestId("story-outline-start"));
    fireEvent.click(screen.getByTestId("resplit-story-confirm"));
    await waitFor(() => expect(starts).toHaveLength(1));
    await comesBack();

    await waitFor(() => {
      expect(chapters()).toHaveLength(2);
    });
    expect(chapters()[0]?.acts).toHaveLength(1);
    expect(chapters()[0]?.source).toBeDefined();
  });
});

describe("what the table waits on", () => {
  it("offers no redo for a chapter cut from the manuscript", async () => {
    openAtOutline(withManuscript(2));
    fireEvent.click(screen.getByTestId("story-outline-mode-split"));
    fireEvent.click(screen.getByTestId("story-outline-start"));
    await waitFor(() => expect(starts).toHaveLength(1));
    await comesBack();
    await waitFor(() => expect(chapters()).toHaveLength(2));

    expect(screen.queryByTestId("story-chapter-redo-0")).toBeNull();
    expect(screen.getByTestId("story-chapter-source-0")).toBeTruthy();
  });

  it("offers a redo for a chapter written from the premise, and waits on it alone", async () => {
    openAtOutline(withChapters());
    answers["outline:rewrite:1"] = JSON.stringify({
      title: "站台",
      synopsis: "站台上只剩一个人。",
    });

    fireEvent.click(screen.getByTestId("story-chapter-redo-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]?.items[0]?.id).toBe("outline:rewrite:1");
    expect(
      (screen.getByTestId("story-chapter-redo-0") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("story-chapter-redo-1") as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    await comesBack();
    await waitFor(() => {
      expect(chapters()[0]?.synopsis).toBe("站台上只剩一个人。");
    });
  });
});
