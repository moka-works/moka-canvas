// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import type {
  StoryJobItemDraft,
  StoryJobKind,
  StoryJobRecord,
} from "../../../api/story";
import type { MokaFile } from "../../../shared/domain";
import {
  buildLongStory,
  buildStoryMokaFile,
  storyIds,
} from "../../../shared/domain/fixtures";
import { createAct, createKeyframe } from "../../../shared/domain/factories";
import { clampSeconds } from "../jobs/plan";
import { undo } from "../../editor/commands/execute";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useModelStore } from "../../settings/modelStore";
import { StoryPage } from "../StoryPage";
import { useStoryJobStore } from "../stores/storyJobStore";
import { useStoryStore } from "../stores/storyStore";

const ids = storyIds();
const T0 = "2026-01-01T00:00:00.000Z";

/** What the room handed the server, in the order it handed it over. */
let starts: Array<{ kind: StoryJobKind; items: StoryJobItemDraft[] }> = [];
/** The batches the server is holding, newest first. */
let held: StoryJobRecord[] = [];
/** What each piece of the next batch is answered with, by the piece's id. */
let answers: Record<string, string> = {};
/**
 * The pieces that have come home with a file, by the piece's id, when the test
 * answers only some of them. Left empty, the whole batch answers at once, which
 * is what most of these tests want.
 */
let landed: Record<string, string[]> = {};

/** The server under the test, as the other steps' tests serve it. */
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
        return Promise.resolve(new Response(""));
      }
      if (url.includes("/api/v1/projects/current")) {
        return json({
          root: "/tmp/moka-board-test",
          moka: useProjectStore.getState().moka,
          selfCheck: { ok: true, issues: [] },
        });
      }
      return json({});
    }),
  );
}

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
    createdAt: T0,
    updatedAt: T0,
  };
}

/** The same batch as it comes home, every piece answered as the test said. */
function answered(record: StoryJobRecord): StoryJobRecord {
  const partial = Object.keys(landed).length > 0;
  const items = record.items.map((item) => {
    const files = partial
      ? landed[item.id]
      : [`asset-${item.id.replace(/[^\w-]/g, "-")}`];
    if (files === undefined) return item;
    return {
      ...item,
      status: "succeeded" as const,
      assetIds: files,
      ...(answers[item.id] !== undefined ? { text: answers[item.id] } : {}),
    };
  });
  // A batch still owing a piece is still out, which is what a look at it says
  // whether or not some of its answers have landed.
  return {
    ...record,
    status: items.every((item) => item.status === "succeeded")
      ? "succeeded"
      : "running",
    items,
  };
}

/** The batch the room started, coming home with its answers. */
async function comesBack(which = starts.length): Promise<void> {
  const found = held.find((job) => job.id === `job-${which}`);
  if (found === undefined) throw new Error("a batch was started first");
  await act(async () => {
    await useStoryJobStore.getState().adopt(found.id);
  });
}

/**
 * The fixture with a cast every one of which has been described and drawn,
 * which is what a board with no gaps in it reads.
 */
function boarded(): MokaFile {
  const moka = buildStoryMokaFile();
  const story = moka.stories![0];
  settle(story, "周", (element) => {
    element.turnaround = {
      takes: [{ assetIds: ["asset-partner-sheet"], createdAt: T0 }],
    };
  });
  settle(story, "旧车票", (element) => {
    element.main = {
      takes: [{ assetIds: ["asset-prop-main"], createdAt: T0 }],
    };
  });
  return moka;
}

/** One element of the cast, as the reader settled it. */
function settle(
  story: NonNullable<MokaFile["stories"]>[number],
  name: string,
  change: (element: (typeof story.elements)[number]) => void,
): void {
  const element = story.elements.find((held) => held.name === name);
  if (element === undefined) throw new Error(`the fixture holds ${name}`);
  change(element);
}

/** The same telling with every frame of its first act drawn. */
function withEveryFrame(): MokaFile {
  const moka = boarded();
  const act = moka.stories![0].chapters[0]!.acts[0]!;
  for (const keyframe of act.keyframes) {
    if (keyframe.art.takes.length === 0) {
      keyframe.art = {
        takes: [{ assetIds: [`asset-${keyframe.id}`], createdAt: T0 }],
      };
    }
  }
  return moka;
}

/**
 * The same telling with both of its first act's shots still waiting for a
 * picture: the state a board is in just after it has been read.
 */
function withUndrawnFrames(): MokaFile {
  const moka = boarded();
  const act = moka.stories![0].chapters[0]!.acts[0]!;
  for (const keyframe of act.keyframes) keyframe.art = { takes: [] };
  return moka;
}

/** The same telling with the place it happens in not yet drawn. */
function withoutThePlace(): MokaFile {
  const moka = boarded();
  settle(moka.stories![0], "末班车车厢", (element) => {
    element.main = { takes: [] };
  });
  return moka;
}

/**
 * The same act with one more shot, none of them drawn — room for a batch to be
 * out on one shot while the shots beside it go on being askable.
 */
function withThreeUndrawnShots(): MokaFile {
  const moka = withUndrawnFrames();
  const act = moka.stories![0].chapters[0]!.acts[0]!;
  act.keyframes = [
    ...act.keyframes,
    createKeyframe(act.keyframes.length, "medium", "static", "eyeLevel"),
  ];
  return moka;
}

/**
 * The same episode with a second act whose shots nobody has drawn yet: the act
 * a batch drawing the first one must leave alone.
 */
function withASecondAct(): MokaFile {
  const moka = withThreeUndrawnShots();
  const chapter = moka.stories![0].chapters[0]!;
  chapter.acts.push({
    ...createAct("第 2 幕 空车厢", "灯管忽明忽暗。"),
    keyframes: [createKeyframe(0)],
  });
  return moka;
}

/** The same telling with its first act's clip not yet made. */
function withoutTheClip(): MokaFile {
  const moka = withEveryFrame();
  moka.stories![0].chapters[0]!.acts[0]!.video = { takes: [] };
  return moka;
}

/** The same telling cut shot by shot, with its first shot already filmed. */
function withFilmedShot(): MokaFile {
  const moka = withEveryFrame();
  const story = moka.stories![0];
  const act = story.chapters[0]!.acts[0]!;
  story.shotGranularity = "keyframe";
  act.keyframes[0]!.video = {
    takes: [{ assetIds: ["asset-first-shot-clip"], createdAt: T0 }],
  };
  return moka;
}

/**
 * The room as a reader reaches step four with this episode open.
 *
 * The step is stood on rather than clicked to: whether the door opens is the
 * shell's business, and a test about a board wants a board.
 */
function openAtBoard(moka: MokaFile, chapter = 0): void {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-board-test",
    selfCheck: { ok: true, issues: [] },
  });
  useStoryStore.getState().adopt(moka);
  const target = moka.stories![0].chapters[chapter];
  if (target !== undefined) useStoryStore.getState().openChapter(target.id);
  render(<StoryPage />);
  act(() => useStoryStore.getState().goStep("storyboard"));
}

function story() {
  const heldStory = useProjectStore.getState().moka?.stories?.[0];
  if (heldStory === undefined) throw new Error("a story is open");
  return heldStory;
}

/** The acts of the episode the room has open, which is the one under test. */
function acts() {
  const held = story();
  const open = useStoryStore.getState().openChapterId;
  const chapter = held.chapters.find((each) => each.id === open);
  return (chapter ?? held.chapters[0])?.acts ?? [];
}

/** The line under test, as the document holds it. */
function storyLine() {
  return acts()[0]?.keyframes[0]?.dialogue[0];
}

/** That line's latest reading, as the file it holds. */
function lineVoice(): string | undefined {
  const take = acts()[0]?.keyframes[0]?.voices?.find(
    (held) => held.lineId === ids.lineFirst,
  );
  return take?.slot.takes.at(-1)?.assetIds[0];
}

function card(index: number): HTMLElement {
  return screen.getByTestId(`story-act-${index}`);
}

/** An answer as a model writes one: acts of shots in the shape asked for. */
function boardAnswer(...shotSizes: string[]): string {
  return JSON.stringify({
    acts: [
      {
        title: "上车",
        summary: "他在最后一秒钟挤上车门。",
        characters: ["林", "周"],
        scene: "末班车车厢",
        props: [],
        sound: { music: "低沉的弦乐", sfx: "车门蜂鸣", ambience: "车厢底噪" },
        keyframes: shotSizes.map((shotSize, index) => ({
          shotSize,
          cameraMove: "pushIn",
          angle: "eyeLevel",
          content: `第 ${index + 1} 格的画面。`,
          durationMs: 2_000,
          dialogue: [],
        })),
      },
    ],
  });
}

/**
 * A deployment whose video settings name a length.
 *
 * The number is what a canvas node asks for when nobody says — six seconds by
 * default — and what a test sets here is what the room reads while planning a
 * batch, which is where a telling's own lengths must survive it.
 */
function filmingAt(seconds: number): void {
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
          seconds,
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
        story: { splitChars: 12_000, readChars: 8_000 },
      },
      secretStorage: "unset",
    },
  });
}

/** The settings with a video model that films at most this long. */
function filmingWithCeiling(maxSeconds: number): void {
  filmingAt(6);
  const view = useModelStore.getState().view;
  if (view === null) throw new Error("the settings were just set");
  useModelStore.setState({
    view: {
      ...view,
      models: [
        {
          id: "filmer",
          category: "video",
          protocol: "bailianVideo",
          url: "https://provider.test/video-synthesis",
          model: "filmer",
          displayName: "Filmer",
          maxVideoSeconds: maxSeconds,
          enabled: true,
          apiKey: { set: false, masked: null },
        },
      ],
      defaults: { ...view.defaults, video: "filmer" },
    },
  });
}

beforeEach(() => {
  starts = [];
  held = [];
  answers = {};
  landed = {};
  serving();
  localStorage.clear();
  // Every test starts on a machine whose settings say nothing, which is the
  // state a room is read in unless a test sets a deployment of its own.
  useModelStore.setState({ view: null });
  useProjectStore.getState().close();
  useStoryStore.getState().forget();
  useStoryJobStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("writing an episode's board", () => {
  it("stands a picker for every kind of work the step asks", () => {
    openAtBoard(boarded());
    // Words, pictures, clips, voices and the score are all asked for from
    // step four, so a reader sets each of them here rather than in settings.
    for (const place of ["text", "image", "video", "audio", "music"]) {
      expect(screen.getByTestId(`story-model-${place}`)).toBeDefined();
    }
  });

  it("asks for the board as a table of chapters, and writes it into the story", async () => {
    openAtBoard(boarded(), 1);
    answers[`storyboard:${story().chapters[1]!.id}`] = boardAnswer(
      "close",
      "medium",
    );

    // With no board yet the header's ask writes one straight away, and says so.
    expect(screen.getByTestId("story-board-generate").textContent).toBe(
      "Write the board",
    );
    fireEvent.click(screen.getByTestId("story-board-generate"));
    await waitFor(() => expect(starts).toHaveLength(1));
    const [item] = starts[0]!.items;
    expect(starts[0]!.kind).toBe("storyboard");
    expect(item?.capability).toBe("text");
    expect(item?.prompt).toContain("林");
    expect(item?.prompt).toContain("末班车车厢");

    await comesBack();
    await waitFor(() =>
      expect(screen.getByTestId("story-act-0")).toBeDefined(),
    );
    expect(within(card(0)).getByTestId("story-table")).toBeDefined();
    expect(acts()).toHaveLength(1);
    expect(acts()[0]?.keyframes).toHaveLength(2);
  });

  it("draws the pictures the words of a shot name, in the order they appear", async () => {
    openAtBoard(boarded());

    // The board is written and the picture is one press away: nothing about a
    // table has to be agreed to before what is written in it is drawn.
    fireEvent.click(screen.getByTestId("story-act-draw-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    const [item] = starts[0]!.items;
    expect(starts[0]!.kind).toBe("keyframeArt");
    // The shot's words name the picture that travels with it, in the order the
    // names first appear; a name left as plain words carries nothing.
    expect(item?.inputs?.map((input) => input.assetId)).toEqual([
      ids.partnerMain,
    ]);
    expect(item?.prompt).toContain("1. 周");
    expect(item?.prompt).not.toContain("旧车票");
  });

  it("shows the ask as it will be sent, with the mentioned names and their pictures", () => {
    openAtBoard(boarded());
    // The scaffolding the template writes — the episode, the framing, the look
    // — stands around the shot's own words as the greyed part of the cell.
    const prompt = screen.getByTestId("story-kf-prompt-0").textContent ?? "";
    expect(prompt).toContain('One frame of a film, from "第一章 站台"');
    expect(prompt).toContain("It is a wide shot");
    expect(prompt).toContain("in the film's own look: 现代都市风");
    expect(prompt).toContain("1. 林 — ");
    // The one name the words mention stands as a chip, and its picture rides.
    const cell = screen.getByTestId("story-kf-content-0");
    const chips = cell.querySelectorAll("[data-mention-name]");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toBe("林");
    expect(chips[0]?.className).toContain("is-carried");
    const thumbs = screen.getByTestId("story-kf-refs-0");
    expect(within(thumbs).getAllByRole("button")).toHaveLength(1);
    expect(thumbs.querySelector("img")?.getAttribute("src")).toContain(
      ids.heroMain,
    );
  });

  it("drops a picture when its mention is taken out of the words", async () => {
    openAtBoard(boarded());
    const field = screen.getByTestId("story-kf-content-0");
    expect(screen.getByTestId("story-kf-refs-0")).toBeDefined();
    // The chip is one thing: taking it out takes the name out of the words and
    // its picture out of the ask, together.
    field.querySelector("[data-mention-name]")?.remove();
    fireEvent.input(field);
    await waitFor(() =>
      expect(screen.queryByTestId("story-kf-refs-0")).toBeNull(),
    );
    fireEvent.blur(field);
    await waitFor(() =>
      expect(story().chapters[0]!.acts[0]!.keyframes[0]!.content).toBe(
        "雨中的站台，立在灯下。",
      ),
    );
  });

  it("marks a name the limit leaves behind, and one nobody has drawn", () => {
    const moka = boarded();
    const held = moka.stories![0]!;
    held.maxReferenceImages = 2;
    held.chapters[0]!.acts[0]!.keyframes[0]!.content =
      "`林`看着`周`，`末班车车厢`里很暗。";
    openAtBoard(moka);
    const cell = screen.getByTestId("story-kf-content-0");
    const chips = Array.from(cell.querySelectorAll("[data-mention-name]"));
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "林",
      "周",
      "末班车车厢",
    ]);
    expect(chips[0]?.className).toContain("is-carried");
    expect(chips[1]?.className).toContain("is-carried");
    // The third mention is drawn and over the limit: its words stay, its
    // picture stands dimmed among the ones that travel.
    expect(chips[2]?.className).toContain("is-beyond");
    expect(
      within(screen.getByTestId("story-kf-refs-0")).getAllByRole("button"),
    ).toHaveLength(3);
    expect(screen.getByTestId("story-kf-ref-beyond-0-0")).toBeDefined();
  });

  it("leaves a mentioned name nobody has drawn to the words", () => {
    const moka = buildStoryMokaFile();
    moka.stories![0]!.chapters[0]!.acts[0]!.keyframes[0]!.content =
      "`旧车票`攥在手里。";
    openAtBoard(moka);
    const chip = screen
      .getByTestId("story-kf-content-0")
      .querySelector("[data-mention-name]");
    expect(chip?.className).toContain("is-undrawn");
    expect(screen.queryByTestId("story-kf-refs-0")).toBeNull();
  });

  it("writes the reference limit the reader sets beside the models", async () => {
    openAtBoard(boarded());
    const input = screen.getByTestId("story-max-refs") as HTMLInputElement;
    expect(input.value).toBe("3");
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.blur(input);
    await waitFor(() => expect(story().maxReferenceImages).toBe(5));
  });

  it("keeps the table open after the board is written, with nothing in it to agree to", async () => {
    openAtBoard(boarded());
    const first = card(0);

    // A board is argued with rather than sealed: there is no agreement on the
    // table and none on its pictures, so a cell written after the board was
    // written is simply the board.
    expect(within(first).queryByTestId("story-act-keys-0")).toBeNull();
    expect(within(first).queryByTestId("story-act-unlock-0")).toBeNull();
    expect(within(first).queryByTestId("story-act-keys-on-0")).toBeNull();
    expect(
      within(first).queryByTestId("story-act-images-confirm-0"),
    ).toBeNull();
    expect(within(first).queryByTestId("story-kf-slot-0-confirm")).toBeNull();

    fireEvent.change(within(first).getByTestId("story-kf-size-1"), {
      target: { value: "medium" },
    });
    await waitFor(() =>
      expect(acts()[0]?.keyframes[1]?.shotSize).toBe("medium"),
    );
    expect(useHistoryStore.getState().undoStack.length).toBeGreaterThan(0);
  });

  it("waits on the shot being drawn while the rest of the act stays askable", async () => {
    openAtBoard(withASecondAct());
    const first = card(0);

    // Two shots of the one act are asked for on their own, one after the other:
    // two batches out for one act, which is what nothing about them needs.
    fireEvent.click(within(first).getByTestId("story-kf-slot-0-generate"));
    await waitFor(() => expect(starts).toHaveLength(1));
    fireEvent.click(within(first).getByTestId("story-kf-slot-1-generate"));
    await waitFor(() => expect(starts).toHaveLength(2));

    // The shots being drawn say so, offer no second ask of themselves — and the
    // shot nobody is drawing is still one a reader can ask for on its own.
    for (const at of [0, 1]) {
      const slot = within(first).getByTestId(`story-kf-slot-${at}`);
      expect(slot.textContent).toContain("Drawing…");
      expect(
        within(slot).queryByTestId(`story-kf-slot-${at}-generate`),
      ).toBeNull();
    }
    const own = within(first).getByTestId(
      "story-kf-slot-2-generate",
    ) as HTMLButtonElement;
    expect(own.disabled).toBe(false);
    // Which is also what the act's own button and the board's count: the work
    // still to ask for, not the work already handed over.
    expect(within(first).getByTestId("story-act-draw-0").textContent).toBe(
      "Draw the missing frames (1)",
    );
    // The board counts the work of every act it holds, the second one's shot
    // among it: nothing about a board is left out of what it offers to do.
    expect(screen.getByTestId("story-board-draw-missing").textContent).toBe(
      "Draw every missing frame (2)",
    );

    // One of the two answers while the other is still being painted: the place
    // it landed in shows it, the place still being drawn still says so, and the
    // rest of the episode is the reader's throughout — a batch drawing one shot
    // is not the whole board waiting.
    landed[`keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`] = [
      "asset-frame-first",
    ];
    await comesBack(1);
    await waitFor(() =>
      expect(
        within(first).getByTestId("story-kf-slot-0").querySelector("img"),
      ).not.toBeNull(),
    );
    expect(within(first).getByTestId("story-kf-slot-1").textContent).toContain(
      "Drawing…",
    );
    const second = card(1);
    // The second act's own table and its own ask are the reader's throughout:
    // a batch drawing one act is not the whole board waiting.
    expect(
      (within(second).getByTestId("story-kf-size-0") as HTMLSelectElement)
        .disabled,
    ).toBe(false);
    expect(
      (within(second).getByTestId("story-act-draw-1") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByTestId("story-board-regenerate") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("shows a shot's picture as it lands while the rest are still being drawn", async () => {
    openAtBoard(withUndrawnFrames());
    const first = card(0);
    fireEvent.click(within(first).getByTestId("story-act-draw-0"));
    await waitFor(() => expect(starts).toHaveLength(1));

    // The first of the two answers while the batch is still out: its own place
    // shows the picture rather than waiting for the whole batch to be over.
    landed[`keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`] = [
      "asset-frame-first",
    ];
    await comesBack();
    await waitFor(() =>
      expect(
        within(first)
          .getByTestId("story-kf-slot-0")
          .querySelector("img")
          ?.getAttribute("src"),
      ).toBe("/api/v1/projects/current/assets/asset-frame-first"),
    );

    // The one still on its way shows a place being painted, not one drawn.
    expect(within(first).getByTestId("story-kf-slot-1").textContent).toContain(
      "Drawing…",
    );
    expect(
      within(first).getByTestId("story-kf-slot-1").querySelector("img"),
    ).toBeNull();

    // The second lands and the batch is over: the act holds both pictures.
    landed[`keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameSecond}`] = [
      "asset-frame-second",
    ];
    await comesBack();
    await waitFor(() =>
      expect(acts()[0]?.keyframes[1]?.art.takes).toHaveLength(1),
    );
    expect(
      within(first).getByTestId("story-kf-slot-1").querySelector("img"),
    ).not.toBeNull();
  });

  it("says which references are missing rather than refusing to draw", async () => {
    openAtBoard(withoutThePlace());
    expect(screen.getByTestId("story-act-missing-ref-0").textContent).toContain(
      "末班车车厢",
    );

    fireEvent.click(screen.getByTestId("story-act-draw-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(
      starts[0]!.items[0]?.inputs?.map((input) => input.assetId),
    ).not.toContain(ids.sceneMain);
  });

  it("has nothing per frame to agree to: drawn frames are what the clip waits on", () => {
    openAtBoard(withEveryFrame());
    const first = card(0);

    expect(within(first).queryByTestId("story-kf-slot-0-confirm")).toBeNull();
    expect(screen.queryByTestId("story-act-images-confirm-0")).toBeNull();
    // Every frame drawn: the act's clip is one press away.
    expect(
      (screen.getByTestId("story-act-video-again-0") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("waits for every frame to be drawn before the act's clip is asked for", () => {
    const moka = withUndrawnFrames();
    moka.stories![0].chapters[0]!.acts[0]!.video = { takes: [] };
    openAtBoard(moka);
    const go = screen.getByTestId("story-act-video-go-0") as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(go.getAttribute("title")).toContain("every frame");
    // A step-level press is the only agreement the board has, and it says the
    // same thing: the pictures are what is missing.
    fireEvent.click(screen.getByTestId("story-confirm-storyboard"));
    expect(
      screen.getByTestId("story-confirm-gaps-storyboard").textContent,
    ).toContain("2 shots have no frame drawn yet");
  });

  it("films an act once its frames are drawn, for as long as it plans", async () => {
    // The video settings say what a canvas node asks for when nobody says:
    // three seconds here. What a board plans is its own, and the act is asked
    // for the five seconds its shots add up to rather than for the default.
    filmingAt(3);
    openAtBoard(withoutTheClip());
    // Every frame is drawn, which is the whole of what the ask waits on.
    expect(
      (screen.getByTestId("story-act-video-go-0") as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.click(screen.getByTestId("story-act-video-go-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    const [item] = starts[0]!.items;
    expect(starts[0]!.kind).toBe("actVideo");
    expect(item?.capability).toBe("video");
    expect(item?.params?.seconds).toBe(clampSeconds(5_000));
    expect(item?.prompt).toContain("about 5 seconds");
    expect(item?.params?.ratio).toBe(story().brief.aspect);
    // Two shots, two pictures, and neither frame given a shoot role: they
    // travel as the references the clip is drawn from, and the mode says so.
    expect(item?.inputs?.map((input) => input.role)).toEqual([
      "reference",
      "reference",
    ]);
    expect(item?.params?.mode).toBe("reference");
  });

  it("gives every drawn frame a shoot role, and writes the one the reader picks", async () => {
    openAtBoard(withEveryFrame());
    const first = card(0);

    const head = within(first).getByTestId(
      "story-kf-role-0",
    ) as HTMLSelectElement;
    expect(head.value).toBe("reference");
    expect(head.options.length).toBe(3);
    expect(head.getAttribute("aria-label")).toContain("Shoot role");
    // Nothing is drawn after the last frame, so it cannot open a pair; every
    // frame before it may.
    const tail = within(first).getByTestId(
      "story-kf-role-1",
    ) as HTMLSelectElement;
    expect([...tail.options].map((option) => option.value)).toEqual([
      "reference",
      "firstFrame",
    ]);

    fireEvent.change(head, { target: { value: "firstLastFrame" } });
    await waitFor(() =>
      expect(acts()[0]?.keyframes[0]?.filmRole).toBe("firstLastFrame"),
    );
  });

  it("takes the closing frame's role away once the frame before it pairs with it", async () => {
    openAtBoard(withEveryFrame());
    const first = card(0);

    const tail = () =>
      within(first).getByTestId("story-kf-role-1") as HTMLSelectElement;
    expect(tail().disabled).toBe(false);

    fireEvent.change(within(first).getByTestId("story-kf-role-0"), {
      target: { value: "firstLastFrame" },
    });
    await waitFor(() => expect(tail().disabled).toBe(true));
    expect(tail().getAttribute("title")).toContain("closing frame");

    // Taken back, the closing frame is the reader's again.
    fireEvent.change(within(first).getByTestId("story-kf-role-0"), {
      target: { value: "reference" },
    });
    await waitFor(() => expect(tail().disabled).toBe(false));
  });

  it("shows a role the board can no longer offer rather than rewriting it", () => {
    const moka = withEveryFrame();
    moka.stories![0].chapters[0]!.acts[0]!.keyframes[1]!.filmRole =
      "firstLastFrame";
    openAtBoard(moka);

    const tail = within(card(0)).getByTestId(
      "story-kf-role-1",
    ) as HTMLSelectElement;
    expect(tail.value).toBe("firstLastFrame");
    expect(
      [...tail.options].find((option) => option.value === "firstLastFrame")
        ?.disabled,
    ).toBe(true);
  });

  it("offers no shoot role when the story is cut shot by shot", () => {
    openAtBoard(withFilmedShot());
    expect(screen.queryByTestId("story-kf-role-0")).toBeNull();
  });

  it("asks for the act's clip again from the row that plays it", async () => {
    openAtBoard(withoutTheClip());

    // While no clip is there the first ask is the only one.
    expect(screen.queryByTestId("story-act-video-again-0")).toBeNull();
    fireEvent.click(screen.getByTestId("story-act-video-go-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    await comesBack();

    // The clip is home, and the same ask stands beside it: a reader who does
    // not like what came back is not left holding it.
    const again = screen.getByTestId(
      "story-act-video-again-0",
    ) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    fireEvent.click(again);
    await waitFor(() => expect(starts).toHaveLength(2));
    expect(starts[1]!.kind).toBe("actVideo");
    expect(starts[1]!.items[0]?.id).toBe(starts[0]!.items[0]?.id);
  });

  it("plays a clip filmed in pieces as the pieces, one after another", () => {
    const moka = boarded();
    const held = moka.stories![0].chapters[0]!.acts[0]!;
    held.video = {
      takes: [
        {
          assetIds: ["asset-piece-one", "asset-piece-two"],
          createdAt: T0,
        },
      ],
    };
    openAtBoard(moka);
    fireEvent.click(screen.getByTestId("story-act-video-0"));

    const lightbox = screen.getByTestId("story-lightbox");
    const piece = () => screen.getByTestId("story-lightbox-piece").textContent;
    expect(piece()).toBe("Part 1 of 2");
    expect(lightbox.querySelector("video")?.getAttribute("src")).toContain(
      "asset-piece-one",
    );

    // The first piece ending opens the second, which is the order the card and
    // the finished cut read them in.
    fireEvent.ended(lightbox.querySelector("video")!);
    expect(piece()).toBe("Part 2 of 2");
    expect(lightbox.querySelector("video")?.getAttribute("src")).toContain(
      "asset-piece-two",
    );
  });

  it("asks a long act in pieces, and says so beside the plan", async () => {
    // The video model films fifteen seconds at a time and the act runs for
    // eighteen: it is filmed in two pieces, and the row says so before the ask.
    const moka = withoutTheClip();
    const held = moka.stories![0].chapters[0]!.acts[0]!;
    for (const keyframe of held.keyframes) keyframe.durationMs = 9_000;
    filmingWithCeiling(15);
    openAtBoard(moka);

    expect(screen.getByTestId("story-act-split-0").textContent).toContain("2");
    fireEvent.click(screen.getByTestId("story-act-video-go-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.items.map((item) => item.params?.seconds)).toEqual([
      9, 9,
    ]);
    expect(starts[0]!.items.map((item) => item.id)).toEqual([
      `actVideo:${ids.chapterFirst}:${ids.act}:1`,
      `actVideo:${ids.chapterFirst}:${ids.act}:2`,
    ]);
  });

  it("says out loud when a shot cannot be cut and the clip is cut short", async () => {
    // A shot has no end to be cut at, so a shot longer than the model films is
    // made as long as it can be, and the row says what the whole ask comes to.
    const moka = withoutTheClip();
    const held = moka.stories![0].chapters[0]!.acts[0]!;
    for (const keyframe of held.keyframes) keyframe.durationMs = 900_000;
    filmingWithCeiling(15);
    openAtBoard(moka);

    expect(screen.getByTestId("story-act-clamp-0").textContent).toContain("30");
    fireEvent.click(screen.getByTestId("story-act-video-go-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.items.map((item) => item.params?.seconds)).toEqual([
      15, 15,
    ]);
  });

  it("films shot by shot, each from its own frame to the next", async () => {
    const moka = withEveryFrame();
    const act = moka.stories![0].chapters[0]!.acts[0]!;
    act.keyframes[1]!.art = {
      takes: [{ assetIds: ["asset-second-frame"], createdAt: T0 }],
    };
    openAtBoard(moka);

    // The act already holds a clip, so changing how clips are made is a
    // question rather than a switch — and the clips already made stay put.
    fireEvent.click(screen.getByTestId("story-granularity-keyframe"));
    expect(screen.getByTestId("change-granularity")).toBeDefined();
    fireEvent.click(screen.getByTestId("change-granularity-confirm"));
    await waitFor(() => expect(story().shotGranularity).toBe("keyframe"));
    expect(acts()[0]?.video.takes).toHaveLength(1);

    fireEvent.click(screen.getByTestId("story-kf-video-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    let item = starts[0]!.items[0];
    expect(starts[0]!.kind).toBe("keyframeVideo");
    expect(item?.inputs?.map((input) => [input.role, input.assetId])).toEqual([
      ["firstFrame", ids.frameArt],
      ["lastFrame", "asset-second-frame"],
    ]);
    expect(item?.params?.seconds).toBe(clampSeconds(2_000));

    // One shot is filmed at a time: the act's other shots wait for this one to
    // come home before they are asked for.
    await comesBack();

    // The last shot has nothing after it to end on, so it is filmed from its
    // own frame alone.
    fireEvent.click(screen.getByTestId("story-kf-video-1"));
    await waitFor(() => expect(starts).toHaveLength(2));
    item = starts[1]!.items[0];
    expect(item?.inputs?.map((input) => input.role)).toEqual(["firstFrame"]);
  });

  it("asks for a shot's clip again from the row that holds it", async () => {
    openAtBoard(withFilmedShot());
    const first = card(0);

    // The shot holds a clip, and its row says what may be done about it: the
    // take asked over beside the take settled on — while the shot next to it,
    // holding nothing, still asks for its first.
    expect(within(first).queryByTestId("story-kf-video-0")).toBeNull();
    const again = within(first).getByTestId(
      "story-kf-video-again-0",
    ) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(within(first).getByTestId("story-kf-video-1")).toBeDefined();

    fireEvent.click(again);
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.kind).toBe("keyframeVideo");
    expect(starts[0]!.items[0]?.id).toBe(
      `keyframeVideo:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`,
    );
  });

  it("asks before writing an episode's board again, and lists what it costs", async () => {
    openAtBoard(boarded());
    // An episode that already has a board is asked for by its second name, and
    // the ask stands behind a question rather than writing over it at once.
    expect(screen.getByTestId("story-board-regenerate").textContent).toBe(
      "Write the board again",
    );
    fireEvent.click(screen.getByTestId("story-board-regenerate"));
    const dialog = screen.getByTestId("regenerate-board");
    expect(dialog.textContent).toContain("1 act");
    expect(dialog.textContent).toContain("episode 1");

    fireEvent.click(screen.getByTestId("regenerate-board-cancel"));
    expect(starts).toHaveLength(0);

    fireEvent.click(screen.getByTestId("story-board-regenerate"));
    fireEvent.click(screen.getByTestId("regenerate-board-confirm"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.items[0]?.id).toBe(
      `storyboard:${story().chapters[0]!.id}`,
    );
  });

  it("marks the cells whose framing the answer never really gave", async () => {
    openAtBoard(boarded(), 1);
    answers[`storyboard:${story().chapters[1]!.id}`] = boardAnswer("遥遥远景");

    fireEvent.click(screen.getByTestId("story-board-generate"));
    await waitFor(() => expect(starts).toHaveLength(1));
    await comesBack();
    await waitFor(() =>
      expect(screen.getByTestId("story-act-0")).toBeDefined(),
    );
    const mark = within(card(0)).getByTestId("story-guessed-size-0");
    expect(mark.getAttribute("title")).toContain("遥遥远景");
    expect(acts()[0]?.keyframes[0]?.shotSize).toBe("medium");
  });

  it("writes the lines of a shot as one step, off screen ones included", async () => {
    openAtBoard(boarded());
    fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));
    expect(screen.getByTestId("story-dialogue")).toBeDefined();

    fireEvent.click(screen.getByTestId("story-line-add"));
    fireEvent.change(screen.getByTestId("story-line-speaker-1"), {
      target: { value: "画外音" },
    });
    fireEvent.change(screen.getByTestId("story-line-text-1"), {
      target: { value: "末班车，不停了。" },
    });
    fireEvent.change(screen.getByTestId("story-line-text-0"), {
      target: { value: "车已经停运了。" },
    });
    fireEvent.click(screen.getByTestId("story-line-done"));

    await waitFor(() =>
      expect(acts()[0]?.keyframes[0]?.dialogue).toHaveLength(2),
    );
    const lines = acts()[0]?.keyframes[0]?.dialogue ?? [];
    // Every line arrives with a name of its own, and no two share one: what a
    // take read aloud is filed under is the line's own name.
    expect(lines[0]?.id).toBeTruthy();
    expect(lines[1]?.id).toBeTruthy();
    expect(lines[0]?.id).not.toBe(lines[1]?.id);
    expect(lines[0]?.speaker).toBe("林");
    expect(lines[0]?.text).toBe("车已经停运了。");
    expect(lines[1]?.speaker).toBe("画外音");
    expect(lines[1]?.text).toBe("末班车，不停了。");
    expect(lines[1]?.characterId).toBeUndefined();
  });

  it("gives a line the character it is read by, and reads a typed name against the cast", async () => {
    openAtBoard(boarded());
    fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));

    // The line the board wrote for 林 opens with him picked, his name beside it.
    const pick = screen.getByTestId("story-line-role-0") as HTMLSelectElement;
    expect(pick.value).toBe(ids.hero);
    expect(
      (screen.getByTestId("story-line-speaker-0") as HTMLInputElement).value,
    ).toBe("林");

    // Picking another character of the act carries his name with him.
    fireEvent.change(pick, { target: { value: ids.partner } });
    expect(
      (screen.getByTestId("story-line-speaker-0") as HTMLInputElement).value,
    ).toBe("周");
    fireEvent.click(screen.getByTestId("story-line-done"));
    await waitFor(() =>
      expect(acts()[0]?.keyframes[0]?.dialogue[0]?.characterId).toBe(
        ids.partner,
      ),
    );
    expect(acts()[0]?.keyframes[0]?.dialogue[0]?.speaker).toBe("周");

    // A name written by hand that is nobody in the cast is a line off the
    // cast, and it keeps the name it was written with.
    fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));
    fireEvent.change(screen.getByTestId("story-line-speaker-0"), {
      target: { value: "广播里的声音" },
    });
    fireEvent.click(screen.getByTestId("story-line-done"));
    await waitFor(() =>
      expect(acts()[0]?.keyframes[0]?.dialogue[0]?.characterId).toBeUndefined(),
    );
    expect(acts()[0]?.keyframes[0]?.dialogue[0]?.speaker).toBe("广播里的声音");
  });

  it("names every control by the shot and the column it belongs to", () => {
    openAtBoard(boarded());
    expect(screen.getByLabelText("shot 1 · Movement")).toBeDefined();
    expect(screen.getByLabelText("shot 2 · Framing")).toBeDefined();
    expect(screen.getByLabelText("shot 1 · Length")).toBeDefined();
    expect(screen.getByTestId("story-kf-add").tagName).toBe("BUTTON");
  });

  it("adds and takes away shots by writing the act's table whole", async () => {
    openAtBoard(boarded());
    fireEvent.click(screen.getByTestId("story-kf-add"));
    await waitFor(() => expect(acts()[0]?.keyframes).toHaveLength(3));

    fireEvent.click(screen.getByTestId("story-kf-remove-1"));
    await waitFor(() => expect(acts()[0]?.keyframes).toHaveLength(2));
    expect(acts()[0]?.keyframes[0]?.id).toBe(ids.frameFirst);
  });

  it("inserts a shot above the row it was asked for, and the rest keep their places", async () => {
    openAtBoard(boarded());
    fireEvent.click(screen.getByTestId("story-kf-insert-1"));
    await waitFor(() => expect(acts()[0]?.keyframes).toHaveLength(3));

    const frames = acts()[0]!.keyframes;
    expect(frames[0]?.id).toBe(ids.frameFirst);
    expect(frames[2]?.id).toBe(ids.frameSecond);
    expect(frames[1]?.content).toBe("");
    expect(frames[1]?.art.takes).toHaveLength(0);
    // The rows are the shots in their order: the third row is the one that
    // stood second, drawn for as long as its own picture is there.
    expect(
      (screen.getByTestId("story-kf-size-2") as HTMLSelectElement).value,
    ).toBe("close");
    expect(
      screen.getByTestId("story-kf-slot-2").querySelector("img"),
    ).toBeNull();

    act(() => {
      undo();
    });
    expect(acts()[0]?.keyframes).toHaveLength(2);
  });

  it("moves a shot up and down the act, and the ends say so", async () => {
    openAtBoard(boarded());
    const first = acts()[0]!.keyframes[0]!;
    expect(
      (screen.getByTestId("story-kf-up-0") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("story-kf-down-1") as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByTestId("story-kf-down-0"));
    await waitFor(() =>
      expect(acts()[0]?.keyframes[0]?.id).toBe(ids.frameSecond),
    );
    // The picture drawn for the shot travels with it: what moved is the place
    // in the list rather than the shot, so nothing is asked for again.
    expect(acts()[0]?.keyframes[1]?.id).toBe(ids.frameFirst);
    expect(acts()[0]?.keyframes[1]?.art.takes[0]?.assetIds[0]).toBe(
      first.art.takes[0]?.assetIds[0],
    );
    // And the rows read the document: the first row is the shot that moved up.
    expect(
      (screen.getByTestId("story-kf-size-0") as HTMLSelectElement).value,
    ).toBe("close");

    act(() => {
      undo();
    });
    expect(acts()[0]?.keyframes[0]?.id).toBe(ids.frameFirst);
  });

  it("carries a shot's shoot role with it when the board is reordered", async () => {
    const moka = withEveryFrame();
    moka.stories![0].chapters[0]!.acts[0]!.keyframes[1]!.filmRole =
      "firstFrame";
    openAtBoard(moka);

    fireEvent.click(screen.getByTestId("story-kf-down-0"));
    await waitFor(() =>
      expect(acts()[0]?.keyframes[0]?.id).toBe(ids.frameSecond),
    );
    // The role belongs to the shot rather than to its place: the shot was
    // moved rather than written again, so what it is filmed as travels with it.
    expect(acts()[0]?.keyframes[0]?.filmRole).toBe("firstFrame");
    expect(
      (screen.getByTestId("story-kf-role-0") as HTMLSelectElement).value,
    ).toBe("firstFrame");
  });

  it("adds an act at the seam it was asked for, ready to be written into", async () => {
    openAtBoard(boarded());
    fireEvent.click(screen.getByTestId("story-act-insert-1"));
    await waitFor(() => expect(acts()).toHaveLength(2));

    // The act that was there stays whole, with its shots where they stood; the
    // new one is named by its place and is nobody's work yet.
    expect(acts()[0]?.id).toBe(ids.act);
    expect(acts()[0]?.keyframes).toHaveLength(2);
    expect(acts()[1]?.title).toBe("Act 2");
    expect(acts()[1]?.keyframes).toHaveLength(0);
    expect(screen.getByTestId("story-act-insert-0")).toBeDefined();
    expect(screen.getByTestId("story-act-insert-2")).toBeDefined();

    act(() => {
      undo();
    });
    expect(acts()).toHaveLength(1);
  });

  it("moves an act up and down the episode, everything it holds travelling with it", async () => {
    openAtBoard(withASecondAct());
    const [first, second] = acts();
    expect(
      (screen.getByTestId("story-act-up-0") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("story-act-down-1") as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByTestId("story-act-down-0"));
    await waitFor(() => expect(acts()[0]?.id).toBe(second!.id));
    // The act is moved rather than written again: its shots and the frames in
    // them are the ones it had.
    expect(acts()[1]?.id).toBe(first!.id);
    expect(acts()[0]?.keyframes).toHaveLength(1);
    expect(acts()[1]?.keyframes).toHaveLength(3);

    act(() => {
      undo();
    });
    expect(acts()[0]?.id).toBe(first!.id);
  });

  it("takes an act out whole once the reader has said so", async () => {
    openAtBoard(withASecondAct());
    const held = acts()[0]!;
    fireEvent.click(screen.getByTestId("story-act-remove-0"));
    const asked = screen.getByTestId("remove-act");
    expect(asked.textContent).toContain(held.title);
    expect(asked.textContent).toContain("3 shots");

    fireEvent.click(screen.getByTestId("remove-act-cancel"));
    expect(acts()).toHaveLength(2);

    fireEvent.click(screen.getByTestId("story-act-remove-0"));
    fireEvent.click(screen.getByTestId("remove-act-confirm"));
    await waitFor(() => expect(acts()).toHaveLength(1));
    expect(acts()[0]?.id).not.toBe(held.id);

    // Its shots go with it, and the whole of it comes back on undo.
    act(() => {
      undo();
    });
    expect(acts()).toHaveLength(2);
    expect(acts()[0]?.keyframes).toHaveLength(3);
  });

  it("reads a line aloud on its own, and shows the take that comes back", async () => {
    openAtBoard(boarded());
    // The first act says one line; the room counts it out on the button.
    const speak = screen.getByTestId("story-act-voice-go-0");
    expect(speak.textContent).toContain("1");
    fireEvent.click(speak);

    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.kind).toBe("voice");
    // One ask a line, named by the line it reads.
    expect(starts[0]!.items.map((item) => item.id)).toEqual([
      `lineVoice:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}:${ids.lineFirst}`,
    ]);
    expect(starts[0]!.items[0]!.prompt).toContain("车已经停运了。");
    // The words travel as the line's own, without the speaker or the tone
    // being read out: the tone rides in the instructions.
    expect(starts[0]!.items[0]!.prompt).not.toContain("林：");
    expect(String(starts[0]!.items[0]!.params?.instructions)).toContain("平静");

    await comesBack();
    const taken = `asset-lineVoice-${ids.chapterFirst}-${ids.act}-${ids.frameFirst}-${ids.lineFirst}`;
    await waitFor(() => expect(lineVoice()).toBe(taken));
    // A take that came back is played where it lies, and can be replaced.
    fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));
    expect(
      screen.getByTestId("story-line-voice-take-0").getAttribute("src"),
    ).toContain(taken);
    expect(
      screen.getByTestId("story-line-voice-state-0").textContent,
    ).toContain("Read");
    // And the act's own button has nothing left to count.
    expect(screen.queryByTestId("story-act-voice-go-0")).toBeNull();
    expect(screen.getByTestId("story-act-voice-count-0").textContent).toContain(
      "1",
    );
  });

  it("counts a line whose words changed, and asks for it again alone", async () => {
    openAtBoard(boarded());
    fireEvent.click(screen.getByTestId("story-act-voice-go-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    await comesBack();
    await waitFor(() => expect(lineVoice()).toBeDefined());

    // The line as it stands has its reading, so the button is gone.
    expect(screen.queryByTestId("story-act-voice-go-0")).toBeNull();
    fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));
    expect(
      screen.getByTestId("story-line-voice-state-0").textContent,
    ).toContain("Read");

    // Rewritten, it is short of a reading again — and says why.
    fireEvent.change(screen.getByTestId("story-line-text-0"), {
      target: { value: "车不会来了。" },
    });
    fireEvent.click(screen.getByTestId("story-line-done"));
    await waitFor(() => expect(storyLine()?.text).toBe("车不会来了。"));
    fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));
    expect(
      screen.getByTestId("story-line-voice-state-0").textContent,
    ).toContain("The words changed");
    // The act counts it again, and the old take is still there to hear.
    const speak = screen.getByTestId("story-act-voice-go-0");
    expect(speak.textContent).toContain("1");
    expect(
      screen.getByTestId("story-line-voice-take-0").getAttribute("src"),
    ).toContain("asset-lineVoice");

    // Asking again is another take for the line, not a replacement of what was
    // said before: the room waits out this batch, so the answer has to be ready
    // before the ask goes out.
    landed[
      `lineVoice:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}:${ids.lineFirst}`
    ] = ["asset-lineVoice-reread"];
    fireEvent.click(screen.getByTestId("story-line-voice-go-0"));
    await waitFor(() => expect(starts).toHaveLength(2));
    expect(starts[1]!.items.map((item) => item.id)).toEqual([
      `lineVoice:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}:${ids.lineFirst}`,
    ]);
    await comesBack();
    await waitFor(() => expect(lineVoice()).toBe("asset-lineVoice-reread"));
    expect(acts()[0]!.keyframes[0]!.voices?.[0]?.slot.takes).toHaveLength(2);
  });

  it("asks for the score once the board says what the act sounds like", async () => {
    const moka = boarded();
    const act = moka.stories![0].chapters[0]!.acts[0]!;
    act.sound = { music: "", sfx: "", ambience: "" };
    openAtBoard(moka);
    const score = screen.getByTestId("story-act-music-go-0");
    expect((score as HTMLButtonElement).disabled).toBe(true);
    expect(score.getAttribute("title")).toContain("sounds like");

    fireEvent.change(screen.getByTestId("story-act-sound-music-0"), {
      target: { value: "低音提琴" },
    });
    fireEvent.blur(screen.getByTestId("story-act-sound-music-0"));
    await waitFor(() => expect(acts()[0]?.sound.music).toBe("低音提琴"));
    await waitFor(() =>
      expect(
        (screen.getByTestId("story-act-music-go-0") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );

    fireEvent.click(screen.getByTestId("story-act-music-go-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.kind).toBe("music");
    expect(starts[0]!.items[0]?.capability).toBe("music");
    expect(starts[0]!.items[0]?.params).toEqual({ instrumental: true });
  });

  it("says when an episode has sound, since assembling carries it", async () => {
    const moka = boarded();
    const act = moka.stories![0].chapters[0]!.acts[0]!;
    act.voice = {
      takes: [{ assetIds: ["asset-act-voice"], createdAt: T0 }],
    };
    openAtBoard(moka);
    expect(screen.getByTestId("story-board-sound").textContent).toContain(
      "goes on the timeline",
    );
    // A reading of the whole act, made before its lines had voices of their
    // own, is kept and playable where it was — and named for what it is.
    expect(
      screen.getByTestId("story-act-voice-0").getAttribute("src"),
    ).toContain("asset-act-voice");
    expect(
      screen.getByTestId("story-act-voice-0").parentElement?.textContent,
    ).toContain("whole act");
  });
});

/**
 * The same telling with its one line already read aloud, the file measured as
 * the test says — an unmeasured file stands for one nobody probed.
 */
function withReadLine(durationMs?: number): MokaFile {
  const moka = boarded();
  const frame = moka.stories![0].chapters[0]!.acts[0]!.keyframes[0]!;
  frame.voices = [
    {
      lineId: ids.lineFirst,
      text: "车已经停运了。",
      voice: "reader-1",
      slot: {
        takes: [{ assetIds: ["asset-line-said"], createdAt: T0 }],
      },
    },
  ];
  moka.resources.voice = [
    {
      id: "asset-line-said",
      name: "said.mp3",
      path: "assets/audio/said.mp3",
      mime: "audio/mpeg",
      createdAt: T0,
      updatedAt: T0,
      ...(durationMs === undefined
        ? {}
        : {
            probe: {
              mime: "audio/mpeg",
              bytes: 2_048,
              sha256: "1".repeat(64),
              durationMs,
            },
          }),
    },
  ];
  return moka;
}

/** The line's own row of the dialogue editor, opened and waiting. */
function openLine(): HTMLElement {
  fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));
  return screen.getByTestId("story-line-voice-fit-0");
}

describe("a reading too long for its shot", () => {
  it("says how much faster it will be read before the cut is made", () => {
    // The shot runs two seconds and the reading is two and two fifths: the
    // card says what fitting it will cost while there is still time to shorten
    // the words or lengthen the shot.
    openAtBoard(withReadLine(2_400));
    expect(openLine().textContent).toContain(
      "0.4s longer than its shot · read 1.20× faster",
    );
  });

  it("says which way a reading past the fastest read runs over", () => {
    openAtBoard(withReadLine(3_400));
    expect(openLine().textContent).toContain(
      "1.4s longer than its shot · read as fast as it may, 0.5s over the shot",
    );
  });

  it("says when nobody measured the reading at all", () => {
    openAtBoard(withReadLine());
    expect(openLine().textContent).toContain(
      "No measured length · laid at the shot's own length",
    );
  });

  it("keeps quiet about a reading that fits its shot", () => {
    openAtBoard(withReadLine(1_200));
    fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));
    expect(screen.queryByTestId("story-line-voice-fit-0")).toBeNull();
  });
});

describe("a telling at every ceiling", () => {
  it("draws the episode it stands on and no other", () => {
    const moka = buildLongStory();
    const standing = moka.stories![0].chapters[0]!;
    openAtBoard(moka);

    // Every episode is a button in the strip; the board under it is the one
    // the room stands on. The other fifty-nine cost a button each, not a
    // table each, which is what makes sixty episodes openable at all.
    expect(screen.getAllByTestId(/^story-board-chapter-\d+$/)).toHaveLength(
      moka.stories![0].chapters.length,
    );
    expect(screen.getAllByTestId(/^story-act-\d+$/)).toHaveLength(
      standing.acts.length,
    );
    expect(screen.queryByTestId("story-act-30")).toBeNull();

    // A budget per shot rather than one flat number: the board is a row of
    // cells with its slots and its words, and how many rows an episode holds
    // is the telling's business. Measured at about fifty-five nodes a shot.
    const shots = standing.acts.reduce(
      (sum, act) => sum + act.keyframes.length,
      0,
    );
    expect(document.querySelectorAll("body *").length).toBeLessThan(shots * 80);
  });
});

describe("the clock each act keeps", () => {
  /** Sets a batch's own clock, so a bar can be read without waiting a minute. */
  function startedAgo(jobId: string, seconds: number): void {
    const at = new Date(Date.now() - seconds * 1000).toISOString();
    useStoryJobStore.setState({
      jobs: useStoryJobStore
        .getState()
        .jobs.map((job) =>
          job.id === jobId ? { ...job, createdAt: at } : job,
        ),
    });
  }

  /** The bars standing in one act, which is what that act is waiting on. */
  function barsIn(index: number): HTMLElement[] {
    return within(card(index)).queryAllByTestId("story-act-running");
  }

  it("stands a batch's bar in the act it works in, and leaves the acts beside it alone", async () => {
    openAtBoard(withASecondAct());
    fireEvent.click(screen.getByTestId("story-act-draw-0"));
    await waitFor(() => expect(barsIn(0)).toHaveLength(1));
    // A bar is one act's own: the act beside it, whose shot nobody is drawing,
    // has nothing to say.
    expect(barsIn(1)).toHaveLength(0);
    // And what it says is that act's own work, counted in pieces and from the
    // batch's clock: three shots out, none of them home.
    startedAgo("job-1", 180);
    await waitFor(() => expect(barsIn(0)[0]!.textContent).toMatch(/03:0\d/));
    expect(barsIn(0)[0]!.textContent).toContain("0/3…");

    // A second ask, this time for the other act's shot: it gets a bar of its
    // own, and the first act's bar is not written over by it.
    fireEvent.click(screen.getByTestId("story-act-draw-1"));
    await waitFor(() => expect(barsIn(1)).toHaveLength(1));
    startedAgo("job-2", 60);
    await waitFor(() => expect(barsIn(1)[0]!.textContent).toMatch(/01:0\d/));
    expect(barsIn(0)).toHaveLength(1);
    expect(barsIn(0)[0]!.textContent).toMatch(/03:0\d/);
  });

  it("keeps one bar per batch when one act has two things out at once", async () => {
    openAtBoard(withUndrawnFrames());
    // Nothing comes home while the test watches, so both waits stand.
    landed["never-asked"] = ["asset-unused"];
    const first = card(0);
    // Two asks of the same act: its two shots drawn, and its line read aloud.
    // Neither is the newer word on the other — they are two waits.
    fireEvent.click(within(first).getByTestId("story-act-draw-0"));
    await waitFor(() => expect(barsIn(0)).toHaveLength(1));
    fireEvent.click(within(first).getByTestId("story-act-voice-go-0"));
    await waitFor(() => expect(barsIn(0)).toHaveLength(2));

    startedAgo("job-1", 300);
    startedAgo("job-2", 60);
    await waitFor(() => {
      const said = barsIn(0).map((bar) => bar.textContent ?? "");
      expect(said.some((text) => /05:0\d/.test(text))).toBe(true);
      expect(said.some((text) => /01:0\d/.test(text))).toBe(true);
    });

    // The batch of two pictures counts its pieces; a one-line ask has no
    // count to give.
    expect(barsIn(0).some((bar) => bar.textContent?.includes("0/2…"))).toBe(
      true,
    );
  });

  it("keeps an episode's board bar over its acts, and off the episode beside it", async () => {
    // The second episode has no board: the header's ask writes one straight
    // away, and the bar it puts up belongs to the episode rather than to any
    // act inside it.
    openAtBoard(boarded(), 1);
    fireEvent.click(screen.getByTestId("story-board-generate"));
    await waitFor(() =>
      expect(screen.getAllByTestId("story-board-running")).toHaveLength(1),
    );
    const bar = screen.getByTestId("story-board-running");
    expect(bar.textContent).toContain("Writing");
    startedAgo("job-1", 120);
    await waitFor(() => expect(bar.textContent).toMatch(/02:0\d/));

    // The episode beside it is not being written and does not say it is: a
    // board's bar stands over the board it is writing, and what the acts there
    // are having made is each act's own bar.
    fireEvent.click(screen.getByTestId("story-board-chapter-0"));
    expect(screen.queryAllByTestId("story-board-running")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("story-act-draw-0"));
    await waitFor(() => expect(barsIn(0)).toHaveLength(1));
    expect(screen.queryAllByTestId("story-board-running")).toHaveLength(0);
  });
});
