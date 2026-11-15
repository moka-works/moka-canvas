import { describe, expect, it } from "vitest";

import { applyCommands } from "../../../shared/domain/commands";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import type {
  MokaFile,
  StoryChapter,
  StoryDocument,
} from "../../../shared/domain/types";
import {
  applyRevision,
  readRevisionAnswer,
  revisionStampOf,
  selectAllRevision,
  type RevisionAnswer,
} from "./revision";

const ids = storyIds();

function file(): MokaFile {
  return buildStoryMokaFile();
}

function storyOf(moka: MokaFile): StoryDocument {
  return moka.stories![0]!;
}

/** A board from v1, with the outline now standing at v2. */
function ahead(chapter: StoryChapter): StoryChapter {
  chapter.revision = 2;
  chapter.boardRevision = 1;
  chapter.boardOutline = {
    title: chapter.title,
    synopsis: "旧梗概：灯还亮着。",
  };
  chapter.synopsis = "新梗概：灯忽然全灭了。";
  return chapter;
}

function answerText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: "灯灭了。",
    needsRebuild: false,
    unmapped: [],
    acts: [],
    keyframes: [],
    ...overrides,
  });
}

function patch(overrides: Record<string, unknown> = {}) {
  return {
    actId: ids.act,
    keyframeId: ids.frameFirst,
    reason: "第 2 段说灯灭了",
    content: "`林`立在熄灭的灯下。",
    ...overrides,
  };
}

function read(chapter: StoryChapter, text: string): RevisionAnswer {
  const reading = readRevisionAnswer(chapter, text);
  expect(reading.error).toBeUndefined();
  return reading.answer!;
}

describe("reading a board revision", () => {
  it("keeps the ids and framing it was given, and drops nothing quietly", () => {
    const chapter = ahead(storyOf(file()).chapters[0]!);
    const answer = read(
      chapter,
      answerText({
        keyframes: [
          patch({
            dialogue: [
              {
                id: ids.lineFirst,
                speaker: "林",
                text: "灯怎么灭了？",
                tone: "警觉",
              },
            ],
            shotSize: "close",
            cameraMove: "pushIn",
            angle: "low",
          }),
        ],
      }),
    );
    expect(answer.keyframes).toHaveLength(1);
    expect(answer.keyframes[0]).toMatchObject({
      keyframeId: ids.frameFirst,
      shotSize: "close",
      cameraMove: "pushIn",
      angle: "low",
    });
    expect(answer.keyframes[0]?.dialogue).toEqual([
      {
        id: ids.lineFirst,
        speaker: "林",
        text: "灯怎么灭了？",
        tone: "警觉",
      },
    ]);
  });

  it("refuses a shot this chapter does not have", () => {
    const chapter = ahead(storyOf(file()).chapters[0]!);
    const reading = readRevisionAnswer(
      chapter,
      answerText({ keyframes: [patch({ keyframeId: "frame-gone" })] }),
    );
    expect(reading.answer).toBeUndefined();
    expect(reading.error).toContain("does not have");
  });

  it("refuses a line the shot does not have", () => {
    const chapter = ahead(storyOf(file()).chapters[0]!);
    const reading = readRevisionAnswer(
      chapter,
      answerText({
        keyframes: [
          patch({
            dialogue: [{ id: "line-gone", speaker: "林", text: "…" }],
          }),
        ],
      }),
    );
    expect(reading.answer).toBeUndefined();
    expect(reading.error).toContain("line it does not have");
  });

  it("reads a framing it does not know as a warning, not a change", () => {
    const chapter = ahead(storyOf(file()).chapters[0]!);
    const reading = readRevisionAnswer(
      chapter,
      answerText({ keyframes: [patch({ shotSize: "dutchAngle" })] }),
    );
    expect(reading.answer?.keyframes[0]?.shotSize).toBeUndefined();
    expect(reading.warnings.join(" ")).toContain("dutchAngle");
  });
});

describe("writing a board revision", () => {
  it("writes the words and framing, keeps the takes, and brings the board up to date", () => {
    const moka = file();
    const chapter = ahead(storyOf(moka).chapters[0]!);
    const answer = read(
      chapter,
      answerText({
        acts: [
          {
            actId: ids.act,
            summary: "站台上的灯忽然全灭了。",
          },
        ],
        keyframes: [
          patch({
            dialogue: [
              {
                id: ids.lineFirst,
                speaker: "林",
                text: "灯怎么灭了？",
                tone: "警觉",
              },
            ],
            shotSize: "close",
            cameraMove: "pushIn",
            angle: "low",
          }),
        ],
      }),
    );
    const revision = applyRevision(
      storyOf(moka),
      chapter,
      answer,
      2,
      selectAllRevision(answer),
    );
    expect(revision.stale).toBe(false);
    expect(revision.complete).toBe(true);
    expect(revision.keyframes).toBe(1);
    expect(revision.acts).toBe(1);
    expect(revision.commands.map((command) => command.type)).toEqual([
      "setStoryActs",
      "setStoryChapters",
    ]);

    const next = applyCommands(moka, revision.commands).next;
    const after = storyOf(next).chapters[0]!;
    expect(after.revision).toBe(2);
    expect(after.boardRevision).toBe(2);
    expect(after.boardOutline).toBeUndefined();
    const act = after.acts[0]!;
    expect(act.summary).toBe("站台上的灯忽然全灭了。");
    const frame = act.keyframes[0]!;
    expect(frame.content).toBe("`林`立在熄灭的灯下。");
    expect(frame.shotSize).toBe("close");
    expect(frame.cameraMove).toBe("pushIn");
    expect(frame.angle).toBe("low");
    // The line keeps its id, and the frame keeps what was made from it.
    expect(frame.dialogue[0]).toMatchObject({
      id: ids.lineFirst,
      characterId: ids.hero,
      text: "灯怎么灭了？",
    });
    expect(frame.art.takes[0]?.assetIds).toEqual([ids.frameArt]);
    expect(act.video.takes[0]?.assetIds).toEqual([ids.actVideo]);
  });

  it("leaves the board behind when a change is left out", () => {
    const moka = file();
    const chapter = ahead(storyOf(moka).chapters[0]!);
    const answer = read(
      chapter,
      answerText({
        keyframes: [
          patch(),
          patch({
            keyframeId: ids.frameSecond,
            content: "`周`在黑暗里转过身来。",
          }),
        ],
      }),
    );
    const revision = applyRevision(storyOf(moka), chapter, answer, 2, {
      keyframes: new Set([ids.frameFirst]),
      acts: new Set(),
    });
    expect(revision.complete).toBe(false);
    expect(revision.commands.map((command) => command.type)).toEqual([
      "setStoryActs",
    ]);

    const next = applyCommands(moka, revision.commands).next;
    const after = storyOf(next).chapters[0]!;
    expect(after.revision).toBe(2);
    expect(after.boardRevision).toBe(1);
    expect(after.boardOutline).not.toBeUndefined();
    expect(after.acts[0]?.keyframes[1]?.content).toBe("`周`转过身来。");
  });

  it("refuses an answer planned from an outline that has moved on", () => {
    const moka = file();
    const chapter = ahead(storyOf(moka).chapters[0]!);
    const answer = read(chapter, answerText({ keyframes: [patch()] }));
    const revision = applyRevision(storyOf(moka), chapter, answer, 3, {
      keyframes: new Set([ids.frameFirst]),
      acts: new Set(),
    });
    expect(revision.stale).toBe(true);
    expect(revision.commands).toEqual([]);
  });

  it("writes nothing when the answer says the board must be rebuilt", () => {
    const moka = file();
    const chapter = ahead(storyOf(moka).chapters[0]!);
    const answer = read(
      chapter,
      answerText({ needsRebuild: true, unmapped: ["换了一个场景"] }),
    );
    const revision = applyRevision(
      storyOf(moka),
      chapter,
      answer,
      2,
      selectAllRevision(answer),
    );
    expect(revision.complete).toBe(false);
    expect(revision.commands).toEqual([]);
  });

  it("says which cast names a rewritten shot now carries", () => {
    const moka = file();
    const chapter = ahead(storyOf(moka).chapters[0]!);
    const answer = read(
      chapter,
      answerText({
        keyframes: [patch({ content: "`林`和`周`立在熄灭的灯下。" })],
      }),
    );
    const revision = applyRevision(
      storyOf(moka),
      chapter,
      answer,
      2,
      selectAllRevision(answer),
    );
    expect(revision.references).toEqual([
      {
        keyframeId: ids.frameFirst,
        before: ["林"],
        after: ["林", "周"],
      },
    ]);
    const next = applyCommands(moka, revision.commands).next;
    expect(
      storyOf(next).chapters[0]!.acts[0]!.keyframes[0]!.references?.map(
        (reference) => reference.name,
      ),
    ).toEqual(["林", "周"]);
  });
});

describe("the stamp a revision is planned at", () => {
  it("reads the chapter and revision out of the piece's id", () => {
    expect(revisionStampOf(`outlineRevision:${ids.chapterFirst}:2`)).toEqual({
      chapterId: ids.chapterFirst,
      revision: 2,
    });
    expect(revisionStampOf("storyboard:chapter-first")).toBeUndefined();
  });
});
