import { describe, expect, it } from "vitest";

import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import type { ActDraft, KeyframeDraft } from "../../../shared/domain/story";
import { checkBoard, type BoardAnswer } from "./board";

const ids = storyIds();
const story = buildStoryMokaFile().stories![0]!;
const chapter = story.chapters[0]!;

function shot(overrides: Partial<KeyframeDraft> = {}): KeyframeDraft {
  return {
    shotSize: "wide",
    cameraMove: "static",
    angle: "eyeLevel",
    content: "`末班车车厢`里，`林`坐在窗边",
    motion: "",
    dialogue: [],
    durationMs: 3_000,
    ...overrides,
  };
}

function act(overrides: Partial<ActDraft> = {}): ActDraft {
  return {
    title: "第 1 幕",
    summary: "灯一盏一盏亮起来。",
    characters: [ids.hero],
    scene: ids.scene,
    props: [],
    sound: { music: "", sfx: "" },
    keyframes: [shot()],
    ...overrides,
  };
}

function answer(drafts: ActDraft[], raw?: unknown): BoardAnswer {
  return {
    drafts,
    warnings: [],
    ...(raw === undefined ? {} : { raw }),
  };
}

describe("checking a board", () => {
  it("keeps a board that says what and who and where", () => {
    expect(checkBoard(story, chapter, answer([act()])).errors).toEqual([]);
  });

  it("refuses an answer with no acts", () => {
    expect(checkBoard(story, chapter, answer([])).errors).not.toEqual([]);
  });

  it("refuses an act with no shots", () => {
    const checked = checkBoard(
      story,
      chapter,
      answer([act({ keyframes: [] })]),
    );
    expect(checked.errors.join(" ")).toContain("no shots");
  });

  it("lets the narrator read a line for someone not in the cast", () => {
    const checked = checkBoard(
      story,
      chapter,
      answer([
        act({
          keyframes: [
            shot({
              dialogue: [{ speaker: "陌生人", text: "让一让。" }],
            }),
          ],
        }),
      ]),
    );
    expect(checked.errors).toEqual([]);
    expect(checked.warnings.join(" ")).toContain("陌生人");
  });

  it("refuses a shot spoken with more lines than one shot keeps", () => {
    const dialogue = Array.from({ length: 13 }, (_, at) => ({
      speaker: "林",
      characterId: ids.hero,
      text: `第 ${at + 1} 句`,
    }));
    const checked = checkBoard(
      story,
      chapter,
      answer([act({ keyframes: [shot({ dialogue })] })]),
    );
    expect(checked.errors.join(" ")).toContain("13 lines");
  });

  it("refuses an answer whose shots were lost in the reading", () => {
    const checked = checkBoard(
      story,
      chapter,
      answer([act()], {
        acts: [{ keyframes: [{ content: "一" }, { content: "二" }] }],
      }),
    );
    expect(checked.errors.join(" ")).toContain("only 1 could be read");
  });

  it("warns when a frame does not name its place", () => {
    const checked = checkBoard(
      story,
      chapter,
      answer([act({ keyframes: [shot({ content: "`林`坐着" })] })]),
    );
    expect(checked.warnings.join(" ")).toContain("does not name its place");
  });

  it("lets a close shot leave its place out of the words", () => {
    const checked = checkBoard(
      story,
      chapter,
      answer([
        act({
          keyframes: [shot({ shotSize: "close", content: "`林`的眼睛" })],
        }),
      ]),
    );
    expect(checked.warnings.join(" ")).not.toContain("does not name its place");
  });

  it("boards exactly the acts a chapter was planned as, by id", () => {
    const held = chapter.acts[0]!;
    const planned = {
      ...chapter,
      acts: [{ ...held, plan: "She waits until the announcement." }],
    };
    const good = checkBoard(story, planned, answer([act({ actId: held.id })]));
    expect(good.errors).toEqual([]);

    const wrong = checkBoard(
      story,
      planned,
      answer([act({ actId: "another-act" })]),
    );
    expect(wrong.errors.join(" ")).toContain("must board the planned act");
  });

  it("warns when motion is written with backticks", () => {
    const checked = checkBoard(
      story,
      chapter,
      answer([act({ keyframes: [shot({ motion: "`林`转身" })] })]),
    );
    expect(checked.warnings.join(" ")).toContain("backticks");
  });

  it("warns when a speaker is not named in the still frame", () => {
    const checked = checkBoard(
      story,
      chapter,
      answer([
        act({
          keyframes: [
            shot({
              dialogue: [
                { speaker: "周", characterId: ids.partner, text: "走吧。" },
              ],
            }),
          ],
        }),
      ]),
    );
    expect(checked.warnings.join(" ")).toContain("周");
  });
});
