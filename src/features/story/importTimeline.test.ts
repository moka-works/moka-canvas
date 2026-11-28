import { beforeEach, describe, expect, it } from "vitest";

import { applyCommands, CommandError } from "../../shared/domain/commands";
import {
  buildEmptyStory,
  buildStoryMokaFile,
  storyIds,
} from "../../shared/domain/fixtures";
import { createAct, createKeyframe } from "../../shared/domain/factories";
import type {
  MokaFile,
  ResourceEntry,
  StoryAct,
  StoryChapter,
  TimelineDocument,
} from "../../shared/domain";
import { useModelStore } from "../settings/modelStore";
import {
  assemblyCommands,
  importTimelineCommands,
  planAssembly,
} from "./assembly";

const ids = storyIds();
const T0 = "2026-01-01T00:00:00.000Z";

/** A piece of sound on the shelf, measured. */
function sound(id: string, durationMs: number): ResourceEntry {
  return {
    id,
    name: `${id}.mp3`,
    path: `assets/voice/${id}.mp3`,
    mime: "audio/mpeg",
    createdAt: T0,
    updatedAt: T0,
    probe: {
      mime: "audio/mpeg",
      bytes: 1024,
      sha256: "0".repeat(64),
      durationMs,
    },
  };
}

/** A clip on the shelf, measured. */
function video(id: string, durationMs: number): ResourceEntry {
  return {
    id,
    name: `${id}.mp4`,
    path: `assets/videos/${id}.mp4`,
    mime: "video/mp4",
    createdAt: T0,
    updatedAt: T0,
    probe: {
      mime: "video/mp4",
      bytes: 1024,
      sha256: "0".repeat(64),
      durationMs,
    },
  };
}

/** One act with a clip of its own, as the fourth step leaves it. */
function filmedAct(id: string, videoId: string, summary: string): StoryAct {
  const act = createAct(`Act ${id}`, summary);
  const shot = createKeyframe(0, "medium", "static", "eyeLevel");
  shot.content = summary;
  shot.durationMs = 1_000;
  act.keyframes = [shot];
  act.video = {
    takes: [{ assetIds: [videoId], createdAt: T0 }],
  };
  return act;
}

/**
 * The fixture, walked further: a filmed act in each episode, and the first
 * act with its lines read aloud and a score under them.
 */
function told(): MokaFile {
  const moka = buildStoryMokaFile();
  const story = moka.stories![0];
  const first = filmedAct("first", ids.actVideo, "站台上的灯亮起来。");
  first.voice = {
    takes: [{ assetIds: ["asset-voice"], createdAt: T0 }],
  };
  first.music = {
    takes: [{ assetIds: ["asset-music"], createdAt: T0 }],
  };
  story.chapters[0] = { ...story.chapters[0], acts: [first] };
  story.chapters[1] = {
    ...story.chapters[1],
    acts: [filmedAct("second", "asset-video-2", "车厢比站台更暗。")],
  };
  moka.resources.videos.push(video("asset-video-2", 4_000));
  moka.resources.voice.push(sound("asset-voice", 3_000));
  moka.resources.music.push(sound("asset-music", 6_000));
  return moka;
}

/** The first episode's own assembled cut, as step five leaves it. */
function assembled(moka: MokaFile): {
  story: NonNullable<MokaFile["stories"]>[number];
  chapter: StoryChapter;
  timeline: TimelineDocument;
} {
  const story = moka.stories![0];
  const chapter = story.chapters[0]!;
  const plan = planAssembly(story, moka, chapter.id);
  const { commands, clipByAct, timelineId } = assemblyCommands(
    story,
    moka,
    plan,
    { withSubtitles: false, timelineName: "第 1 集" },
  );
  const added = commands.find((command) => command.type === "addTimeline");
  if (added?.type !== "addTimeline") throw new Error("a timeline is added");
  story.edit = {
    ...story.edit,
    chapterCuts: [
      {
        chapterId: chapter.id,
        timelineId,
        clipByAct,
        assembledDigest: "0a0b0c0d",
      },
    ],
  };
  moka.timelines = [...(moka.timelines ?? []), added.timeline];
  return { story, chapter, timeline: added.timeline };
}

/** The cut a batch of commands adds, which the import adds exactly one of. */
function addedTimeline(
  moka: MokaFile,
  commands: ReturnType<typeof importTimelineCommands>["commands"],
): TimelineDocument {
  const applied = applyCommands(moka, commands);
  const held = applied.next.timelines ?? [];
  const added = held.filter(
    (timeline) => !(moka.timelines ?? []).some((was) => was.id === timeline.id),
  );
  expect(added).toHaveLength(1);
  return added[0];
}

/** A telling with more shots filmed than a timeline holds. */
function crowded(): MokaFile {
  const moka = buildEmptyStory("挤满的一篇");
  const story = moka.stories![0];
  story.shotGranularity = "keyframe";
  let filmed = 0;
  moka.resources.videos = [];
  const acts = (count: number, chapter: number): StoryAct[] =>
    Array.from({ length: count }, (_, actAt) => {
      const act = createAct(`第 ${actAt + 1} 幕`, "内容");
      act.keyframes = Array.from({ length: 12 }, (_, shotAt) => {
        const shot = createKeyframe(shotAt, "medium", "static", "eyeLevel");
        shot.content = "画面";
        shot.durationMs = 1_000;
        const assetId = `asset-${chapter}-${actAt}-${shotAt}`;
        shot.video = {
          takes: [{ assetIds: [assetId], createdAt: T0 }],
        };
        moka.resources.videos.push(video(assetId, 1_000));
        filmed += 1;
        return shot;
      });
      return act;
    });
  story.chapters = [
    { ...story.chapters[0], acts: acts(30, 0) },
    { ...story.chapters[0], acts: acts(4, 1) },
  ].map((chapter, at) => ({ ...chapter, id: `chapter-${at}` }));
  expect(filmed).toBeGreaterThan(400);
  return moka;
}

beforeEach(() => {
  useModelStore.setState({ view: null });
});

describe("the cut one episode hands over", () => {
  it("is a copy of the episode's assembly, named by the reader", () => {
    const moka = told();
    const { story, chapter, timeline: source } = assembled(moka);
    const { commands, timelineId, clips } = importTimelineCommands(
      story,
      moka,
      chapter,
      "雨夜列车 · 初剪",
    );
    expect(commands).toHaveLength(1);
    const timeline = addedTimeline(moka, commands);
    expect(timeline.id).toBe(timelineId);
    expect(timeline.id).not.toBe(source.id);
    expect(timeline.name).toBe("雨夜列车 · 初剪");
    expect(timeline.settings).toEqual(source.settings);
    expect(clips).toBe(source.clips.length);
    expect(clips).toBe(3);
    // The same pictures and sound, on rows of their own: a copy, not a plan.
    expect(
      timeline.clips.map((clip) => [clip.kind, clip.assetId, clip.startMs]),
    ).toEqual(
      source.clips.map((clip) => [clip.kind, clip.assetId, clip.startMs]),
    );
    expect(timeline.clips.map((clip) => clip.id)).not.toEqual(
      source.clips.map((clip) => clip.id),
    );
    const rowNames = (held: TimelineDocument, clipId: string) =>
      held.tracks.find(
        (track) =>
          track.id === held.clips.find((clip) => clip.id === clipId)?.trackId,
      )?.name;
    expect(rowNames(timeline, timeline.clips[0]!.id)).toBe(
      rowNames(source, source.clips[0]!.id),
    );
  });

  it("keeps the cover, the captions and every row the episode's cut carries", () => {
    const moka = told();
    const { story, chapter, timeline: source } = assembled(moka);
    const track = source.tracks.find((held) => held.kind === "text")!;
    const caption = {
      ...source.clips[0]!,
      id: "caption-take",
      trackId: track.id,
      kind: "text" as const,
      assetId: undefined,
      text: {
        content: "车已经停运了。",
        style: {
          fontFamily: "Inter",
          fontSize: 48,
          color: "#ffffff",
          bold: false,
          italic: false,
          align: "center" as const,
          position: "bottom" as const,
          background: null,
          strokeWidth: 0,
          strokeColor: "#000000",
        },
      },
    };
    source.clips.push(caption);

    const timeline = addedTimeline(
      moka,
      importTimelineCommands(story, moka, chapter, "初剪").commands,
    );
    const copied = timeline.clips.find((clip) => clip.kind === "text");
    expect(copied?.text?.content).toBe("车已经停运了。");
    expect(copied?.id).not.toBe("caption-take");
    expect(timeline.tracks.map((held) => held.name)).toEqual(
      source.tracks.map((held) => held.name),
    );
  });

  it("leaves the episode's own cut and the telling where they stand", () => {
    const moka = told();
    const { story, chapter, timeline: source } = assembled(moka);
    const before = JSON.parse(JSON.stringify(source));
    const cuts = JSON.parse(JSON.stringify(story.edit.chapterCuts));
    const commands = importTimelineCommands(
      story,
      moka,
      chapter,
      "初剪",
    ).commands;
    const applied = applyCommands(moka, commands);
    const after = (applied.next.timelines ?? []).find(
      (timeline) => timeline.id === source.id,
    );
    expect(after).toEqual(before);
    expect(applied.next.stories![0]!.edit.chapterCuts).toEqual(cuts);
    expect(applied.next.timelines).toHaveLength(
      (moka.timelines ?? []).length + 1,
    );
  });

  it("refuses an episode that has not been assembled", () => {
    const moka = told();
    const story = moka.stories![0];
    expect(() =>
      importTimelineCommands(story, moka, story.chapters[0]!, "初剪"),
    ).toThrow(CommandError);
    expect(() =>
      importTimelineCommands(story, moka, story.chapters[0]!, "初剪"),
    ).toThrow(/not been assembled|还没有装配/);
  });

  it("refuses an assembled episode whose timeline has left the project", () => {
    const moka = told();
    const { story, chapter } = assembled(moka);
    story.edit.chapterCuts = [
      { ...story.edit.chapterCuts![0]!, timelineId: "timeline-gone" },
    ];
    expect(() => importTimelineCommands(story, moka, chapter, "初剪")).toThrow(
      CommandError,
    );
  });

  it("refuses a cut with more clips than one timeline holds", () => {
    const moka = crowded();
    const story = moka.stories![0];
    const chapter = story.chapters[0]!;
    const plan = planAssembly(story, moka, chapter.id);
    const { commands, clipByAct, timelineId } = assemblyCommands(
      story,
      moka,
      plan,
      { withSubtitles: false },
    );
    const added = commands.find((command) => command.type === "addTimeline");
    if (added?.type !== "addTimeline") throw new Error("a timeline is added");
    // The document's own ceiling is what the copy is refused against, so the
    // source is put past it directly rather than by filming four hundred acts.
    added.timeline.clips = Array.from({ length: 401 }, (_, at) => ({
      ...added.timeline.clips[0]!,
      id: `clip-${at}`,
      startMs: at * 1_000,
    }));
    moka.timelines = [...(moka.timelines ?? []), added.timeline];
    story.edit.chapterCuts = [
      {
        chapterId: chapter.id,
        timelineId,
        clipByAct,
        assembledDigest: "0a0b0c0d",
      },
    ];
    expect(() => importTimelineCommands(story, moka, chapter, "初剪")).toThrow(
      CommandError,
    );
    try {
      importTimelineCommands(story, moka, chapter, "初剪");
    } catch (problem) {
      expect((problem as Error).message).toContain("400");
    }
  });
});
