import { describe, expect, it } from "vitest";

import { createElement } from "../factories";
import {
  MAX_ACTS_PER_CHAPTER,
  MAX_KEYFRAMES_PER_ACT,
  MAX_KEYFRAME_MS,
  MIN_KEYFRAME_MS,
} from "../constants";
import type { StoryElement } from "../types";
import {
  parseChapter,
  parseElements,
  parseOutline,
  parseStoryboard,
} from "./story";

function element(
  id: string,
  name: string,
  kind: "character" | "scene" | "prop",
) {
  return { ...createElement(kind, name, `${name} 的样子`), id };
}

const ELEMENTS: StoryElement[] = [
  element("el-hero", "林", "character"),
  element("el-partner", "周", "character"),
  element("el-scene", "末班车车厢", "scene"),
  element("el-prop", "旧车票", "prop"),
];

function board(shaped: unknown, targetDurationMs = 20_000) {
  return parseStoryboard(shaped, { elements: ELEMENTS, targetDurationMs });
}

function shot(overrides: Record<string, unknown> = {}) {
  return {
    shotSize: "wide",
    cameraMove: "static",
    angle: "eyeLevel",
    content: "雨中的站台",
    durationMs: 3000,
    dialogue: [],
    ...overrides,
  };
}

function act(overrides: Record<string, unknown> = {}) {
  return {
    title: "第 1 幕",
    summary: "站台上的灯一盏一盏亮起来。",
    characters: ["林"],
    scene: "末班车车厢",
    props: ["旧车票"],
    sound: { music: "低音提琴", sfx: "雨声", ambience: "" },
    keyframes: [shot()],
    ...overrides,
  };
}

describe("the outline", () => {
  it("reads the chapters an answer names", () => {
    const read = parseOutline({
      chapters: [
        { title: "第一章 站台", synopsis: "他在站台上等一班已经停运的列车。" },
        { title: "第二章 车厢", synopsis: "车厢比站台更暗。" },
      ],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toEqual([
        { title: "第一章 站台", synopsis: "他在站台上等一班已经停运的列车。" },
        { title: "第二章 车厢", synopsis: "车厢比站台更暗。" },
      ]);
      expect(read.warnings).toEqual([]);
    }
  });

  it("reads a bare list as the chapters", () => {
    const read = parseOutline([{ title: "一", synopsis: "…" }]);
    expect(read.ok && read.value.length).toBe(1);
  });

  it("keeps the chapters that were written and drops the one that was not", () => {
    const read = parseOutline({
      chapters: [
        { title: "一", synopsis: "…" },
        { title: "二" },
        { title: "三", synopsis: "…" },
      ],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.map((chapter) => chapter.title)).toEqual(["一", "三"]);
      expect(read.warnings).toEqual([
        "chapter 2 had no synopsis and was left out",
      ]);
    }
  });

  it("cuts a synopsis that ran long rather than dropping the chapter", () => {
    const read = parseOutline({
      chapters: [{ title: "一", synopsis: "字".repeat(2500) }],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value[0].synopsis.length).toBe(2000);
      expect(read.warnings.join()).toContain("longer than 2000");
    }
  });

  it("refuses an answer with no chapters in it", () => {
    const read = parseOutline({ title: "一", synopsis: "…" });
    expect(read.ok).toBe(false);
  });

  it("refuses an answer whose every chapter was unreadable", () => {
    const read = parseOutline({ chapters: [{ title: "" }, { synopsis: 3 }] });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toContain("title");
  });
});

describe("one chapter", () => {
  it("reads the title and the synopsis a part was written into", () => {
    const read = parseChapter({ title: "第一章", synopsis: "…" });
    expect(read.ok && read.value).toEqual({ title: "第一章", synopsis: "…" });
  });

  it("refuses an answer with nothing in it", () => {
    expect(parseChapter({ title: "", synopsis: "…" }).ok).toBe(false);
    expect(parseChapter("第一章").ok).toBe(false);
  });
});

describe("the elements", () => {
  it("reads the three lists and the chapters each was noticed in", () => {
    const read = parseElements({
      characters: [
        { name: "林", description: "四十岁上下。", chapters: [1, 2] },
        { name: "周", description: "年轻。", chapters: [] },
      ],
      scenes: [
        { name: "末班车车厢", description: "灯管忽明忽暗。", chapters: [1] },
      ],
      props: [{ name: "旧车票", description: "边角磨圆。" }],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.map((held) => held.kind)).toEqual([
        "character",
        "character",
        "scene",
        "prop",
      ]);
      expect(read.value[0].chapterIndexes).toEqual([0, 1]);
      expect(read.value[1].chapterIndexes).toBeUndefined();
    }
  });

  it("reads a flat list as the characters of the telling", () => {
    const read = parseElements([{ name: "林", description: "四十岁上下。" }]);
    expect(read.ok && read.value[0].kind).toBe("character");
  });

  it("drops what was described without a name, and says so", () => {
    const read = parseElements({
      characters: [
        { name: "林", description: "四十岁上下。" },
        { description: "没有名字。" },
      ],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toHaveLength(1);
      expect(read.warnings.join()).toContain("no name");
    }
  });

  it("reads the near-miss names a model gives the three groups", () => {
    // The ask describes the groups as places and things while its shape names
    // them scenes and props, and a model may answer in either's words: a
    // synonym is not a wrong answer, and dropping it silently would be.
    const read = parseElements({
      characters: [{ name: "林", description: "四十岁上下。" }],
      places: [{ name: "末班车车厢", description: "灯管忽明忽暗。" }],
      things: [{ name: "旧车票", description: "边角磨圆。" }],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.map((held) => held.kind)).toEqual([
        "character",
        "scene",
        "prop",
      ]);
      expect(read.warnings).toEqual([]);
    }
  });

  it("keeps the group the ask asked for when an answer names it twice", () => {
    const read = parseElements({
      scenes: [{ name: "车厢", description: "灯管忽明忽暗。" }],
      places: [{ name: "站台", description: "雨里没有灯。" }],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.map((held) => held.name)).toEqual(["车厢"]);
      // The other name is one the reading knows and did not need, rather than
      // something it could not read.
      expect(read.warnings).toEqual([]);
    }
  });

  it("reads one name said twice as one element, and says so", () => {
    // A long telling is read a part at a time, and a reading that names the
    // same thing twice has named one thing: filed twice it would be two
    // characters who are one person.
    const read = parseElements({
      characters: [
        { name: "林", description: "四十岁上下。", chapters: [1] },
        {
          name: "林",
          description: "四十岁上下，穿深色大衣。",
          chapters: [2],
        },
      ],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toHaveLength(1);
      // The description with more in it stands, since that is what a picture
      // is drawn from, and the chapters add up.
      expect(read.value[0].description).toBe("四十岁上下，穿深色大衣。");
      expect(read.value[0].chapterIndexes).toEqual([0, 1]);
      expect(read.warnings.join()).toContain("was named twice");
    }
  });

  it("hears a name through the airs around it", () => {
    const read = parseElements({
      characters: [
        { name: "林", description: "四十岁上下。" },
        { name: "「林 」", description: "老了十岁。" },
      ],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toHaveLength(1);
    }
  });

  it("says what it could not read rather than passing it over", () => {
    // Half an answer read as a whole one is how a telling ends up with its
    // cast and nothing to draw behind them: what no group is read from is
    // named out loud.
    const read = parseElements({
      characters: [{ name: "林", description: "四十岁上下。" }],
      moods: [{ name: "湿冷", description: "雨水的气味。" }],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toHaveLength(1);
      expect(read.warnings.join()).toContain("moods");
    }
  });

  it("refuses an answer that names none of the three", () => {
    expect(parseElements({ moods: [] }).ok).toBe(false);
    expect(parseElements("林").ok).toBe(false);
  });
});

describe("the board", () => {
  it("reads an act with its cast, its place, its sound and its shots", () => {
    const read = board({ acts: [act()] });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const held = read.value[0];
    expect(held.title).toBe("第 1 幕");
    expect(held.characters).toEqual(["el-hero"]);
    expect(held.scene).toBe("el-scene");
    expect(held.props).toEqual(["el-prop"]);
    expect(held.sound).toEqual({
      music: "低音提琴",
      sfx: "雨声",
      ambience: "",
    });
    expect(held.keyframes[0]).toMatchObject({
      shotSize: "wide",
      cameraMove: "static",
      angle: "eyeLevel",
      content: "雨中的站台",
      durationMs: 3000,
    });
    expect(read.warnings).toEqual([]);
  });

  it("reads a board that is a bare list of acts", () => {
    const read = board([act()]);
    expect(read.ok && read.value.length).toBe(1);
  });

  it("refuses a board with no acts, and one that could not be read at all", () => {
    expect(board({ acts: [] }).ok).toBe(false);
    expect(board("第 1 幕").ok).toBe(false);
    expect(board({ acts: [{ keyframes: [] }] }).ok).toBe(false);
  });

  it("keeps the acts that were boarded and leaves out the one with no shots", () => {
    const read = board({
      acts: [act(), act({ keyframes: [] }), act({ title: "第 3 幕" })],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.map((held) => held.title)).toEqual([
        "第 1 幕",
        "第 3 幕",
      ]);
      expect(read.warnings.join()).toContain("act 2 was boarded with no shots");
    }
  });

  it("keeps only the first acts of a board that ran past the limit", () => {
    const many = Array.from({ length: MAX_ACTS_PER_CHAPTER + 3 }, (_, index) =>
      act({ title: `第 ${index + 1} 幕` }),
    );
    const read = board({ acts: many });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toHaveLength(MAX_ACTS_PER_CHAPTER);
      expect(read.warnings.join()).toContain(
        `only the first ${MAX_ACTS_PER_CHAPTER} were kept`,
      );
    }
  });

  it("keeps only the first shots of an act that ran past the limit", () => {
    const many = Array.from({ length: MAX_KEYFRAMES_PER_ACT + 2 }, () =>
      shot(),
    );
    const read = board({ acts: [act({ keyframes: many })] });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value[0].keyframes).toHaveLength(MAX_KEYFRAMES_PER_ACT);
      expect(read.warnings.join()).toContain("only the first 12 were kept");
    }
  });

  it("leaves out a shot with nothing to show", () => {
    const read = board({
      acts: [act({ keyframes: [shot(), shot({ content: "  " })] })],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value[0].keyframes).toHaveLength(1);
      expect(read.warnings.join()).toContain("nothing to show");
    }
  });
});

describe("the words a board is written with", () => {
  it("reads a framing written the way a person would write it", () => {
    const read = board({
      acts: [
        act({
          keyframes: [
            shot({
              shotSize: "medium close-up",
              cameraMove: "slow push in",
              angle: "over the shoulder",
            }),
          ],
        }),
      ],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value[0].keyframes[0]).toMatchObject({
        shotSize: "mediumClose",
        cameraMove: "pushIn",
        angle: "overTheShoulder",
      });
      expect(read.warnings).toEqual([]);
    }
  });

  it("reads a framing written in Chinese", () => {
    const read = board({
      acts: [
        act({
          keyframes: [
            shot({ shotSize: "近景", cameraMove: "缓慢推进", angle: "俯视" }),
            shot({ shotSize: "远景", cameraMove: "固定", angle: "平视" }),
          ],
        }),
      ],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value[0].keyframes.map((frame) => frame.shotSize)).toEqual([
        "mediumClose",
        "wide",
      ]);
      expect(read.value[0].keyframes.map((frame) => frame.cameraMove)).toEqual([
        "pushIn",
        "static",
      ]);
      expect(read.value[0].keyframes.map((frame) => frame.angle)).toEqual([
        "high",
        "eyeLevel",
      ]);
      expect(read.warnings).toEqual([]);
    }
  });

  it("keeps its own framing for a word it does not know, and says so", () => {
    const read = board({
      acts: [act({ keyframes: [shot({ shotSize: "极远的大特写" })] })],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value[0].keyframes[0].shotSize).toBe("medium");
      expect(read.warnings.join()).toContain("极远的大特写");
      expect(read.warnings.join()).toContain("medium shot");
    }
  });

  it("marks the cells it chose a value for, with the answer's own words", () => {
    const read = board({
      acts: [
        act({
          keyframes: [
            shot({
              shotSize: "遥遥远景",
              cameraMove: "缓缓地绕过去",
              angle: "eyeLevel",
            }),
            shot({ shotSize: "远景", cameraMove: "固定", angle: "歪着看" }),
          ],
        }),
      ],
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value[0].guessed).toEqual([
      { keyframe: 1, field: "shotSize", from: "遥遥远景" },
      { keyframe: 1, field: "cameraMove", from: "缓缓地绕过去" },
      { keyframe: 2, field: "angle", from: "歪着看" },
    ]);
  });

  it("marks nothing on a board every word of which it knows", () => {
    const read = board({ acts: [act()] });
    expect(read.ok && read.value[0].guessed).toBeUndefined();
  });
});

describe("how long a shot is held", () => {
  it("reads the lengths a board gave in seconds and in milliseconds", () => {
    const read = board({
      acts: [
        act({
          keyframes: [
            shot({ durationMs: "3s" }),
            shot({ durationMs: "3000ms" }),
            shot({ durationMs: "3.5" }),
            shot({ durationMs: 2500 }),
          ],
        }),
      ],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value[0].keyframes.map((frame) => frame.durationMs)).toEqual([
        3000, 3000, 3500, 2500,
      ]);
    }
  });

  it("shares the episode out over the shots that did not say", () => {
    const read = board(
      {
        acts: [
          act({
            keyframes: [
              shot({ durationMs: 0 }),
              shot({ durationMs: undefined }),
            ],
          }),
        ],
      },
      20_000,
    );
    expect(read.ok).toBe(true);
    if (read.ok) {
      // Twenty seconds over two shots, and the one that said nothing did not
      // keep the whole episode to itself.
      expect(read.value[0].keyframes.map((frame) => frame.durationMs)).toEqual([
        10_000, 10_000,
      ]);
    }
  });

  it("keeps a length inside what a shot may be held for", () => {
    const read = board({
      acts: [
        act({
          keyframes: [
            shot({ durationMs: 200 }),
            shot({ durationMs: 900_000 }),
            shot({ durationMs: "0.1s" }),
          ],
        }),
      ],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value[0].keyframes.map((frame) => frame.durationMs)).toEqual([
        MIN_KEYFRAME_MS,
        MAX_KEYFRAME_MS,
        MIN_KEYFRAME_MS,
      ]);
    }
  });
});

describe("who a board says is in the shot", () => {
  it("matches a name to the element it names, and counts the unheard of", () => {
    const read = board({
      acts: [
        act({
          characters: ["林", "老周"],
          props: ["旧车票", "雨伞"],
        }),
      ],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value[0].characters).toEqual(["el-hero"]);
      expect(read.value[0].props).toEqual(["el-prop"]);
      expect(read.warnings).toEqual([
        "act 1 names 老周, who is not one of the story's characters",
        "act 1 names 雨伞, who is not one of the story's things",
      ]);
    }
  });

  it("matches a name written without its airs", () => {
    const read = board({ acts: [act({ characters: [" 林 "] })] });
    expect(read.ok && read.value[0].characters).toEqual(["el-hero"]);
  });

  it("names the speaker of a line, and keeps a name it cannot place", () => {
    const read = board({
      acts: [
        act({
          keyframes: [
            shot({
              dialogue: [
                { speaker: "林", text: "车已经停运了。", tone: "平静" },
                { speaker: "路人", text: "让一让。" },
                { speaker: "林", text: "  " },
              ],
            }),
          ],
        }),
      ],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value[0].keyframes[0].dialogue).toEqual([
        {
          characterId: "el-hero",
          speaker: "林",
          text: "车已经停运了。",
          tone: "平静",
        },
        { speaker: "路人", text: "让一让。" },
      ]);
      expect(read.warnings.join()).toContain("had no words");
    }
  });
});

describe("what a board may leave unsaid", () => {
  it("fills in an act's words and sound without dropping its shots", () => {
    const read = board({
      acts: [{ keyframes: [shot()] }],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value[0].title).toBe("");
      expect(read.value[0].summary).toBe("");
      expect(read.value[0].characters).toEqual([]);
      expect(read.value[0].scene).toBeUndefined();
      expect(read.value[0].sound).toEqual({
        music: "",
        sfx: "",
        ambience: "",
      });
      expect(read.warnings).toEqual([
        "act 1 was left without a title",
        "act 1 was left without a summary",
      ]);
    }
  });

  it("keeps a place only when the story has it", () => {
    const read = board({ acts: [act({ scene: "雨夜的站台" })] });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value[0].scene).toBeUndefined();
      expect(read.warnings.join()).toContain("雨夜的站台");
    }
  });
});
