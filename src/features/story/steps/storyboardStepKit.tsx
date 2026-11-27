import { vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

import type {
  StoryJobItemDraft,
  StoryJobKind,
  StoryJobRecord,
} from "../../../api/story";
import type { MokaFile } from "../../../shared/domain";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import { createAct, createKeyframe } from "../../../shared/domain/factories";
import { resetUiPrefs } from "../../../shared/prefs/prefsData";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useModelStore } from "../../settings/modelStore";
import { StoryPage } from "../StoryPage";
import { STORY_PARALLEL_DEFAULT, useStoryBatch } from "../stores/storyBatch";
import { useStoryJobStore } from "../stores/storyJobStore";
import { useStoryModels } from "../stores/storyModels";
import { useStoryStore } from "../stores/storyStore";

export const ids = storyIds();
export const T0 = "2026-01-01T00:00:00.000Z";

/** What the room handed the server, in the order it handed it over. */
export let starts: Array<{
  kind: StoryJobKind;
  items: StoryJobItemDraft[];
  model?: string | null;
  parallel?: number;
}> = [];
/** The batches the server is holding, newest first. */
export let held: StoryJobRecord[] = [];
/** What each piece of the next batch is answered with, by the piece's id. */
export let answers: Record<string, string> = {};
/**
 * The pieces that have come home with a file, by the piece's id, when the test
 * answers only some of them. Left empty, the whole batch answers at once, which
 * is what most of these tests want.
 */
export let landed: Record<string, string[]> = {};

/** The server under the test, as the other steps' tests serve it. */
export function serving(): void {
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
        // A batch asked to stop: one being driven is answered as it stands,
        // with the request marked, since its record is written when it ends.
        const stopping = /\/story\/jobs\/([^/?]+)\/cancel$/.exec(url);
        if (stopping !== null && method === "POST") {
          const found = held.find((job) => job.id === stopping[1]);
          return found === undefined
            ? json({ code: "NOT_FOUND", message: "no" }, 404)
            : json({ ...found, cancelRequested: true });
        }
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            kind: StoryJobKind;
            items: StoryJobItemDraft[];
            model?: string | null;
            parallel?: number;
          };
          starts.push({
            kind: body.kind,
            items: body.items,
            model: body.model ?? null,
            parallel: body.parallel,
          });
          const record = batchOf(
            starts.length,
            body.kind,
            body.items,
            body.model,
          );
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
          selfCheckVerified: true,
        });
      }
      return json({});
    }),
  );
}

export function batchOf(
  number: number,
  kind: StoryJobKind,
  items: StoryJobItemDraft[],
  model?: string | null,
): StoryJobRecord {
  return {
    id: `job-${number}`,
    projectId: "project-1",
    storyId: useProjectStore.getState().moka?.stories?.[0]?.id ?? ids.story,
    kind,
    status: "running",
    // The deployment's default is a model the test machine names by its own
    // stand-in; one the room asked of is the ask's own.
    model: model ?? "a-storyteller",
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
export function answered(record: StoryJobRecord): StoryJobRecord {
  const partial = Object.keys(landed).length > 0;
  const items = record.items.map((item) => {
    // A text answer is the answer: a batch asked for words that has none has
    // not come home, and saying it did would have the room read an empty page.
    const said = answers[item.id];
    if (item.capability === "text" && said === undefined) return item;
    // A video's take carries its batch in the name: two takes of one place are
    // two answers, and apply would read the second as the first kept again
    // without it. A drawing is kept by a set of its own and needs no such mark.
    const stem = `asset-${item.id.replace(/[^\w-]/g, "-")}`;
    const files = partial
      ? landed[item.id]
      : [
          item.target.kind === "actVideo" ||
          item.target.kind === "keyframeVideo"
            ? `${stem}-${record.id}`
            : stem,
        ];
    if (files === undefined) return item;
    return {
      ...item,
      status: "succeeded" as const,
      assetIds: files,
      ...(said !== undefined ? { text: said } : {}),
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
export async function comesBack(which = starts.length): Promise<void> {
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
export function boarded(): MokaFile {
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
export function settle(
  story: NonNullable<MokaFile["stories"]>[number],
  name: string,
  change: (element: (typeof story.elements)[number]) => void,
): void {
  const element = story.elements.find((held) => held.name === name);
  if (element === undefined) throw new Error(`the fixture holds ${name}`);
  change(element);
}

/** The same telling with every frame of its first act drawn. */
export function withEveryFrame(): MokaFile {
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
export function withUndrawnFrames(): MokaFile {
  const moka = boarded();
  const act = moka.stories![0].chapters[0]!.acts[0]!;
  for (const keyframe of act.keyframes) keyframe.art = { takes: [] };
  return moka;
}

/** The same telling with the place it happens in not yet drawn. */
export function withoutThePlace(): MokaFile {
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
export function withThreeUndrawnShots(): MokaFile {
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
export function withASecondAct(): MokaFile {
  const moka = withThreeUndrawnShots();
  const chapter = moka.stories![0].chapters[0]!;
  chapter.acts.push({
    ...createAct("第 2 幕 空车厢", "灯管忽明忽暗。"),
    keyframes: [createKeyframe(0)],
  });
  return moka;
}

/**
 * The same telling whose open episode holds this many acts, each a single
 * shot: a board long enough that pointing at an act beats scrolling to it.
 */
export function withActs(count: number): MokaFile {
  const moka = withEveryFrame();
  const chapter = moka.stories![0].chapters[0]!;
  while (chapter.acts.length < count) {
    const at = chapter.acts.length;
    chapter.acts.push({
      ...createAct(`第 ${at + 1} 幕 车厢`, "灯亮着，没有人说话。"),
      keyframes: [createKeyframe(0)],
    });
  }
  return moka;
}

/** Two acts, every frame of both drawn, with nothing bridged between them yet. */
export function withTwoDrawnActs(): MokaFile {
  const moka = withEveryFrame();
  const chapter = moka.stories![0].chapters[0]!;
  const second = {
    ...createAct("第 2 幕 空车厢", "灯管忽明忽暗。"),
    keyframes: [createKeyframe(0)],
  };
  second.keyframes[0]!.art = {
    takes: [{ assetIds: ["asset-second-act-frame"], createdAt: T0 }],
  };
  chapter.acts.push(second);
  return moka;
}

/** Two acts, each already filmed, with nothing bridged between them yet. */
export function withTwoFilmedActs(): MokaFile {
  const moka = withTwoDrawnActs();
  const [first, second] = moka.stories![0].chapters[0]!.acts;
  first!.video = {
    takes: [
      {
        assetIds: ["asset-first-clip-one", "asset-first-clip-two"],
        createdAt: T0,
      },
    ],
  };
  second!.video = {
    takes: [{ assetIds: ["asset-second-clip"], createdAt: T0 }],
  };
  return moka;
}

/** Two acts whose pictures all stand, neither of them filmed yet. */
export function withTwoMissingClips(): MokaFile {
  const moka = withTwoDrawnActs();
  for (const act of moka.stories![0].chapters[0]!.acts) {
    act.video = { takes: [] };
  }
  return moka;
}

/** The act owed a clip, with an act beside it still waiting on a picture. */
export function withAMissingClipAndAnUndrawnAct(): MokaFile {
  const moka = withoutTheClip();
  const chapter = moka.stories![0].chapters[0]!;
  chapter.acts.push({
    ...createAct("第 2 幕 空车厢", "灯管忽明忽暗。"),
    keyframes: [createKeyframe(0)],
  });
  return moka;
}

/** The same telling with its first act's clip not yet made. */
export function withoutTheClip(): MokaFile {
  const moka = withEveryFrame();
  moka.stories![0].chapters[0]!.acts[0]!.video = { takes: [] };
  return moka;
}

/** The same telling cut shot by shot, with its first shot already filmed. */
export function withFilmedShot(): MokaFile {
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
export function openAtBoard(moka: MokaFile, chapter = 0): void {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-board-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  useStoryStore.getState().adopt(moka);
  const target = moka.stories![0].chapters[chapter];
  if (target !== undefined) useStoryStore.getState().openChapter(target.id);
  render(<StoryPage />);
  act(() => useStoryStore.getState().goStep("storyboard"));
}

/** Puts words in a field and the caret after them, as typing would leave it. */
export function typeAtEnd(field: HTMLElement, text: string): void {
  field.focus();
  field.textContent = text;
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(field);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent.input(field);
}

export function story() {
  const heldStory = useProjectStore.getState().moka?.stories?.[0];
  if (heldStory === undefined) throw new Error("a story is open");
  return heldStory;
}

/** The acts of the episode the room has open, which is the one under test. */
export function acts() {
  const held = story();
  const open = useStoryStore.getState().openChapterId;
  const chapter = held.chapters.find((each) => each.id === open);
  return (chapter ?? held.chapters[0])?.acts ?? [];
}

/** The line under test, as the document holds it. */
export function storyLine() {
  return acts()[0]?.keyframes[0]?.dialogue[0];
}

/** That line's latest reading, as the file it holds. */
export function lineVoice(): string | undefined {
  const take = acts()[0]?.keyframes[0]?.voices?.find(
    (held) => held.lineId === ids.lineFirst,
  );
  return take?.slot.takes.at(-1)?.assetIds[0];
}

export function card(index: number): HTMLElement {
  return screen.getByTestId(`story-act-${index}`);
}

/** Answers the picture dialog a frame's generate press opened. */
export function confirmDraw(): void {
  const dialog = screen.getByTestId("story-image-prompt-dialog");
  fireEvent.click(within(dialog).getByTestId("story-image-prompt-draw"));
}

/** Sends the clip dialog a film press opened. */
export function confirmFilm(): void {
  const dialog = screen.getByTestId("story-video-prompt-dialog");
  fireEvent.click(within(dialog).getByTestId("story-video-prompt-send"));
}

/** An answer as a model writes one: acts of shots in the shape asked for. */
export function boardAnswer(...shotSizes: string[]): string {
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
export function filmingAt(seconds: number): void {
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
        story: { splitChars: 12_000 },
      },
      secretStorage: "unset",
    },
  });
}

/** The settings with two picture models, one of them the deployment's own. */
export function paintingWithTwoModels(): void {
  filmingAt(6);
  const view = useModelStore.getState().view;
  if (view === null) throw new Error("the settings were just set");
  useModelStore.setState({
    view: {
      ...view,
      models: [
        {
          id: "paint-1",
          category: "image",
          protocol: "openaiImage",
          url: "https://provider.test/images",
          model: "paint-1",
          displayName: "Paint One",
          enabled: true,
          apiKey: { set: false, masked: null },
        },
        {
          id: "paint-2",
          category: "image",
          protocol: "openaiImage",
          url: "https://provider.test/images",
          model: "paint-2",
          displayName: "Paint Two",
          enabled: true,
          apiKey: { set: false, masked: null },
        },
      ],
      defaults: { ...view.defaults, image: "paint-1" },
    },
  });
}

/** The settings with a video model that films at most this long. */
export function filmingWithCeiling(maxSeconds: number): void {
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

/**
 * The same telling with its one line already read aloud, the file measured as
 * the test says — an unmeasured file stands for one nobody probed.
 */
export function withReadLine(durationMs?: number): MokaFile {
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
export function openLine(): HTMLElement {
  fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));
  return screen.getByTestId("story-line-voice-fit-0");
}

/** Puts the room on a fresh machine, with nothing out and no settings of its own. */
export function resetStoryboard(): void {
  starts = [];
  held = [];
  answers = {};
  landed = {};
  serving();
  resetUiPrefs();
  useStoryModels.setState({ choices: {} });
  // Every test starts on a machine whose settings say nothing, which is the
  // state a room is read in unless a test sets a deployment of its own. The
  // protocols a dialog reads go with them: half a registry left by one test
  // would be read as a model contract by the next.
  useModelStore.setState({ view: null, protocols: null });
  useStoryBatch.setState({ parallel: STORY_PARALLEL_DEFAULT });
  useProjectStore.getState().close();
  useStoryStore.getState().forget();
  useStoryJobStore.getState().reset();
  // The history outlives a project being put down, and every test is a room
  // entered afresh: without this, one test's edits stand under the next one's
  // undo, and enough of them fill the stack with the doors between rooms.
  useHistoryStore.getState().clear();
}

/** Lets go of the room and whatever was stubbed for it. */
export function cleanupStoryboard(): void {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

/** Replaces what the server is holding, for a test that rewrites it. */
export function replaceHeld(next: StoryJobRecord[]): void {
  held = next;
}

/** Replaces what a batch answers, for a test that answers none of it. */
export function replaceLanded(next: Record<string, string[]>): void {
  landed = next;
}
