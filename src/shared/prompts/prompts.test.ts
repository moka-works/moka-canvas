import { describe, expect, it } from "vitest";

import { stripStoryMentions } from "../domain/story";
import {
  answerSystemPrompt,
  askPrompt,
  contextBlockPrompt,
  describeDefaultPrompt,
  describeFramingPrompt,
  historyLinePrompt,
  historyPrompt,
  rewriteSystemPrompt,
  storyActVideoPrompt,
  storyElementMainPrompt,
  storyElementTurnaroundPrompt,
  storyElementsPrompt,
  storyFactsPrompt,
  storyMergeElementsPrompt,
  storyKeyframePrompt,
  storyKeyframePromptParts,
  storyKeyframeVideoPrompt,
  storyChapterPrompt,
  storyOutlinePrompt,
  storySplitPrompt,
  storySplitRepairPrompt,
  storySplitSystemPrompt,
  storyStoryboardPrompt,
  storySystemPrompt,
  type StoryFacts,
} from "./index";

/**
 * Every template is read here rather than only through the code that sends it,
 * so a template that does not parse, or one whose words drifted from what the
 * callers were written against, fails in one place instead of in whichever
 * dialog happened to be opened.
 */
describe("prompts", () => {
  it("answers from the cards and says so", () => {
    expect(answerSystemPrompt()).toBe(
      "Answer from the cards given to you. Where they do not say, say that rather than filling the gap.",
    );
  });

  it("asks a rewrite for the text and nothing around it", () => {
    expect(rewriteSystemPrompt()).toBe(
      "Send the text given to you back written again as the reader asked. Return only that text, with no heading and nothing said about it.",
    );
  });

  it("starts a description with a question a reader can change", () => {
    expect(describeDefaultPrompt()).toBe(
      "Describe this picture as the prompt that would make it.",
    );
  });

  it("frames a description as the words that would make the picture", () => {
    const framing = describeFramingPrompt();
    expect(framing).toContain("Answer with a description of the picture alone");
    expect(framing.endsWith("no mention of this request.")).toBe(true);
  });

  it("names who said a line of the conversation", () => {
    expect(historyLinePrompt("You", "what is that?")).toBe(
      "You: what is that?",
    );
    expect(historyLinePrompt("Assistant", "a lantern.")).toBe(
      "Assistant: a lantern.",
    );
  });

  it("carries the earlier turns under one heading", () => {
    expect(historyPrompt(["You: hi", "Assistant: hello"])).toBe(
      "Earlier in this conversation:\nYou: hi\nAssistant: hello",
    );
  });

  it("quotes a card under its title", () => {
    expect(contextBlockPrompt("Brief", "A lantern over a lake.")).toBe(
      "[Brief]\nA lantern over a lake.",
    );
  });

  it("puts the parts of a question in the order they are read", () => {
    expect(askPrompt(["cards", "earlier", "the ask"])).toBe(
      "cards\n\n---\n\nearlier\n\n---\n\nthe ask",
    );
  });

  it("leaves out a part there is nothing to say", () => {
    expect(askPrompt(["", "earlier", "the ask"])).toBe(
      "earlier\n\n---\n\nthe ask",
    );
    expect(askPrompt(["the ask"])).toBe("the ask");
    expect(askPrompt([])).toBe("");
  });

  it("writes a reader's own characters rather than a reference to them", () => {
    expect(contextBlockPrompt("Brief", "rock & roll <b>now</b>")).toBe(
      "[Brief]\nrock & roll <b>now</b>",
    );
  });

  it("carries no newline of its own", () => {
    for (const words of [
      answerSystemPrompt(),
      rewriteSystemPrompt(),
      describeDefaultPrompt(),
      describeFramingPrompt(),
      historyLinePrompt("You", "hi"),
      contextBlockPrompt("Brief", "words"),
    ]) {
      expect(words.endsWith("\n")).toBe(false);
    }
  });
});

/**
 * A story's prompts are read here for the same reason the others are, and for
 * one more: they are built out of the brief, and a value that never made it
 * through a hole — a style, a frame, the list a framing has to be chosen from —
 * is an ask that quietly stopped asking for it.
 */
describe("story prompts", () => {
  const facts: StoryFacts = {
    aspect: "16:9",
    genre: "对白剧情",
    style: "现代都市风",
    totalDurationMs: 120_000,
  };

  it("tells a written answer what shape to come back in", () => {
    const system = storySystemPrompt();
    expect(system).toContain("json");
    expect(system).toContain("nothing else");
  });

  it("states the standing facts of the telling", () => {
    const stated = storyFactsPrompt(facts);
    expect(stated).toContain("Aspect: 16:9");
    expect(stated).toContain("Genre: 对白剧情");
    expect(stated).toContain("Visual style: 现代都市风");
    expect(stated).toContain("2:00");
  });

  it("asks for the premise as chapters, carrying the brief with it", () => {
    const prompt = storyOutlinePrompt({
      ...facts,
      idea: "末班列车上，两个陌生人交换了各自要说的话。",
      chapters: 4,
    });
    expect(prompt).toContain("末班列车上，两个陌生人交换了各自要说的话。");
    expect(prompt).toContain("as 4 chapters");
    expect(prompt).toContain("Aspect: 16:9");
    expect(prompt).toContain('"chapters"');
    expect(prompt).not.toContain("{{");
  });

  it("asks where a manuscript's chapters begin and end, not what they say", () => {
    const prompt = storySplitPrompt({
      text: "他在站台上等一班已经停运的列车。",
      part: 2,
      minutes: 3,
      total: "15:00",
      last: false,
    });
    expect(prompt).toContain("part 2 of a manuscript");
    expect(prompt).toContain("他在站台上等一班已经停运的列车。");
    expect(prompt).toContain("about 3 minutes");
    // The manuscript's own divisions decide the count; no number is asked for.
    expect(prompt).toContain("the manuscript's to say");
    expect(prompt).not.toContain("about 5 chapters");
    expect(prompt).toContain('"start"');
    expect(prompt).toContain('"end"');
    expect(prompt).toContain("does not reach the end of the manuscript");
    expect(prompt).toContain("Change nothing");
    expect(prompt).not.toContain("Write this part");
    expect(prompt).not.toContain("{{");
    // The answer's shape stands before the manuscript, so a model does not
    // read the example as part of the text it is asked to cut.
    expect(prompt.indexOf('"chapters"')).toBeLessThan(
      prompt.indexOf("The manuscript:"),
    );
  });

  it("tells the last part that the chapter running to its end closes the telling", () => {
    const prompt = storySplitPrompt({
      text: "他在站台上等一班已经停运的列车。",
      part: 3,
      minutes: 3,
      total: "15:00",
      last: true,
    });
    expect(prompt).toContain("reaches the end of the manuscript");
    expect(prompt).not.toContain("does not reach the end");
    expect(prompt).toContain('"end" stays empty');
  });

  it("asks again for boundaries that could not be found, naming them", () => {
    const prompt = storySplitRepairPrompt({
      text: "他在站台上等一班已经停运的列车。",
      part: 2,
      minutes: 3,
      total: "15:00",
      last: false,
      missing: ["第四章 天亮"],
    });
    expect(prompt).toContain("第四章 天亮");
    expect(prompt).toContain("Copy every");
    expect(prompt).toContain('"end"');
    expect(prompt.indexOf('"chapters"')).toBeLessThan(
      prompt.indexOf("The manuscript:"),
    );
    expect(prompt).not.toContain("{{");
  });

  it("writes one chapter of a premise again in its place", () => {
    const prompt = storyChapterPrompt({
      idea: "末班列车上，两个陌生人交换了各自要说的话。",
      chapters: 4,
      number: 2,
      previous: { number: 1, title: "站台", text: "他等着。" },
      next: { number: 3, title: "天亮", text: "他下了车。" },
      current: { title: "车厢", text: "两个人都不说话。" },
    });
    expect(prompt).toContain("This is chapter 2.");
    expect(prompt).toContain("The chapter before it: 1. 站台 — 他等着。");
    expect(prompt).toContain("The chapter after it: 3. 天亮 — 他下了车。");
    expect(prompt).toContain("What the chapter says now: 车厢");
    expect(prompt).not.toContain("{{");
  });

  it("lists the chapters an answer is read for elements, one person per character", () => {
    const prompt = storyElementsPrompt({
      chapters: [
        { number: 1, title: "第一章 站台", text: "他在站台上等列车。" },
        { number: 2, title: "第二章 车厢", text: "车厢比站台更暗。" },
      ],
      genre: "对白剧情",
      style: "现代都市风",
    });
    expect(prompt).toContain("1. 第一章 站台 — 他在站台上等列车。");
    expect(prompt).toContain("2. 第二章 车厢 — 车厢比站台更暗。");
    expect(prompt).toContain("by the numbers the list above gives them");
    // A couple or a crowd read as one character cannot be drawn: the
    // turn-around is four views of one person, and the cast sheet is one face.
    expect(prompt).toContain("a character is one person");
    expect(prompt).toContain(
      "a couple, a pair, a family or any other two or more the telling follows are that many characters",
    );
    expect(prompt).toContain("is not a character — keep it out of the cast");
    expect(prompt).toContain(
      "name them after the words it uses and what tells them apart",
    );
    // A character's entry is the look the drawings have to keep to. A voice, a
    // habit or a plot the picture cannot show would only make every drawing of
    // them argue with the words.
    expect(prompt).toContain("only what a drawing can show");
    expect(prompt).toContain("no voice or way of speaking");
    expect(prompt).toContain("nothing that happens in the telling");
    expect(prompt).toContain('"characters"');
    expect(prompt).not.toContain("{{");
  });

  it("names only what the telling returns to, not what passes once", () => {
    const prompt = storyElementsPrompt({
      chapters: [
        { number: 1, title: "第一章 站台", text: "他在站台上等列车。" },
      ],
      genre: "对白剧情",
      style: "现代都市风",
    });
    // A listing is a picture every shot of its subject has to keep to, so a
    // passer-by, a room one shot passes through or an object seen once costs a
    // drawing nothing needs and a reference the frame has to work around.
    expect(prompt).toContain("name only what the telling returns to");
    expect(prompt).toContain(
      "again in a later chapter, or more than once across the shots of the chapter it lives in",
    );
    expect(prompt).toContain(
      "A passer-by, a room one shot passes through, an object a single shot holds",
    );
    expect(prompt).toContain("earns no entry of its own");
    expect(prompt).toContain("leave it out of all three lists");
    expect(prompt).toContain("anything only one shot shows");
  });

  it("keeps a scene to one place, and its change to its description", () => {
    const prompt = storyElementsPrompt({
      chapters: [
        { number: 1, title: "第一章 站台", text: "他在站台上等列车。" },
      ],
      genre: "对白剧情",
      style: "现代都市风",
    });
    // A scene is drawn once and every shot of that place points at the one
    // picture, so two places in one entry cannot be drawn and an hour or a
    // weather of its own is a state the drawing is given, not a second entry.
    expect(prompt).toContain("one place to an entry");
    expect(prompt).toContain(
      "is still the one place, with the change written into its description",
    );
    // "Each at their own workplace" is words that cover two places, and a
    // picture of one place cannot stand for both: the entry has to name the
    // concrete place a shot stands in, one entry per person's own.
    expect(prompt).toContain("an entry is one concrete place");
    expect(prompt).toContain(
      "two people each at their own workplace are two scenes, one for each place",
    );
    expect(prompt).toContain(
      "the one workplace they stand in together is still the one",
    );
  });

  it("asks for props a shot must show, not light or weather", () => {
    const prompt = storyElementsPrompt({
      chapters: [
        { number: 1, title: "第一章 站台", text: "他在站台上等列车。" },
      ],
      genre: "对白剧情",
      style: "现代都市风",
    });
    // A prop is drawn on its own and carried into the shots as a reference
    // picture, so one nobody has to design — light, a moon, a chair — is a
    // drawing owed for nothing and a reference the frame must work around.
    expect(prompt).toContain(
      "only earns a listing where the story turns on it",
    );
    expect(prompt).toContain("are not props");
    expect(prompt).toContain("Leave out anything no shot would have to show");
    expect(prompt).toContain(
      "Do not invent anyone or anything that is not in the telling",
    );
  });

  it("merges the parts' descriptions of one name, and nothing else", () => {
    const prompt = storyMergeElementsPrompt({
      groups: [
        {
          kind: "character",
          name: "林玉兰",
          descriptions: ["五十岁，短发。", "便利店店主，总是系围裙。"],
        },
        {
          kind: "scene",
          name: "便利店",
          descriptions: ["深夜仍亮着灯的店面。", "收银台后的货架摆得很满。"],
        },
      ],
      genre: "对白剧情",
      style: "现代都市风",
      part: 1,
      total: 2,
    });
    expect(prompt).toContain('- character "林玉兰"');
    expect(prompt).toContain("  - 五十岁，短发。");
    expect(prompt).toContain("  - 便利店店主，总是系围裙。");
    expect(prompt).toContain('- scene "便利店"');
    // The model is asked for new words about the names it is given, not for a
    // cast: an entry it invented or left out would change the room's list.
    expect(prompt).toContain("do not add or leave out an entry");
    expect(prompt).toContain("do not rename the thing");
    // Merging the parts' words is still a character's look, not a script: the
    // merge must not bring a voice or a plot into the description.
    expect(prompt).toContain("only what a drawing can show");
    expect(prompt).toContain("no voice, habits, manner");
    expect(prompt).toContain("This is merge 1 of 2");
    expect(prompt).toContain('"characters"');
    expect(prompt).not.toContain("{{");
  });

  it("boards a chapter with the names it must be written in", () => {
    const prompt = storyStoryboardPrompt({
      ...facts,
      number: 2,
      chapter: { title: "第二章 车厢", text: "车厢比站台更暗。" },
      targetDurationMs: 60_000,
      elements: [
        { kind: "character", name: "林", description: "四十岁上下。" },
        { kind: "scene", name: "末班车车厢", description: "灯管忽明忽暗。" },
      ],
      shotSizes: ["mediumClose", "wide"],
      cameraMoves: ["static", "pushIn"],
      angles: ["eyeLevel", "high"],
    });
    expect(prompt).toContain("Chapter 2 of the telling: 第二章 车厢");
    expect(prompt).toContain("- 林 (character) — 四十岁上下。");
    expect(prompt).toContain("- 末班车车厢 (scene) — 灯管忽明忽暗。");
    expect(prompt).toContain("60 seconds");
    expect(prompt).toContain("mediumClose, wide");
    expect(prompt).toContain("static, pushIn");
    expect(prompt).toContain("eyeLevel, high");
    expect(prompt).toContain('"keyframes"');
    expect(prompt).not.toContain("{{");
  });

  it("draws a character whole, in the film's own look", () => {
    const prompt = storyElementMainPrompt({
      aspect: "16:9",
      style: "现代都市风",
      kind: "character",
      name: "林",
      description: "四十岁上下，深色大衣，说话很慢。",
    });
    expect(prompt).toContain("林 — 四十岁上下，深色大衣，说话很慢。");
    expect(prompt).toContain("现代都市风");
    expect(prompt).toContain("16:9");
    expect(prompt).toContain("head to foot");
    expect(prompt).toContain("plain white background");
    expect(prompt).toContain("no watermark");
    expect(prompt).not.toContain("{{");
  });

  it("draws a place as a place rather than as a person", () => {
    const prompt = storyElementMainPrompt({
      aspect: "16:9",
      style: "现代都市风",
      kind: "scene",
      name: "末班车车厢",
      description: "空车厢，灯管忽明忽暗。",
    });
    expect(prompt).toContain("unmistakable");
    expect(prompt).not.toContain("head to foot");
    expect(prompt).not.toContain("white background");
  });

  it("draws a thing on its own, with no place behind it", () => {
    const prompt = storyElementMainPrompt({
      aspect: "16:9",
      style: "现代都市风",
      kind: "prop",
      name: "旧车票",
      description: "发黄的车票，边角磨损。",
    });
    expect(prompt).toContain("旧车票 — 发黄的车票，边角磨损。");
    expect(prompt).toContain("plain white background");
    expect(prompt).not.toContain("head to foot");
  });

  it("asks for four views of one character on one picture", () => {
    const prompt = storyElementTurnaroundPrompt({
      aspect: "16:9",
      style: "现代都市风",
      name: "林",
      description: "四十岁上下。",
    });
    expect(prompt).toContain("four views");
    expect(prompt).toContain("white background");
    expect(prompt).toContain("林 — 四十岁上下。");
    expect(prompt).toContain("现代都市风");
  });

  it("numbers a frame's references in the order its pictures travel", () => {
    const prompt = storyKeyframePrompt({
      aspect: "16:9",
      style: "现代都市风",
      chapter: { title: "第一章 站台" },
      act: { summary: "站台上的灯一盏一盏亮起来。" },
      keyframe: {
        content: "雨中的站台，一个人立在灯下。",
        shotSize: "wide",
        cameraMove: "pushIn",
        angle: "eyeLevel",
      },
      cast: [
        { name: "林", description: "四十岁上下。" },
        { name: "周", description: "年轻。" },
      ],
    });
    expect(prompt).toContain("第一章 站台");
    expect(prompt).toContain("雨中的站台，一个人立在灯下。");
    expect(prompt).toContain("wide shot");
    expect(prompt).toContain("pushIn");
    expect(prompt).toContain("1. 林 — 四十岁上下。");
    expect(prompt).toContain("2. 周 — 年轻。");
    expect(prompt).toContain("现代都市风");
    expect(prompt).not.toContain("{{");
  });

  it("reads the ask apart around the shot's words, and sends them without the marks", () => {
    const input = {
      aspect: "16:9" as const,
      style: "现代都市风",
      chapter: { title: "第一章 站台" },
      act: { summary: "站台上的灯一盏一盏亮起来。" },
      keyframe: {
        content: "雨中的站台，`林`立在灯下。",
        shotSize: "wide",
        cameraMove: "pushIn",
        angle: "eyeLevel",
      },
      cast: [{ name: "林", description: "四十岁上下。" }],
    };
    const parts = storyKeyframePromptParts(input);
    // The hole the content is written into sits between the scaffolding: what
    // comes before it ends at the shot's introduction, and nothing of the
    // shot's own words is in the greyed part.
    expect(parts.content).toBe("雨中的站台，`林`立在灯下。");
    expect(parts.before).toContain("This shot: ");
    expect(parts.before).not.toContain("雨中的站台");
    expect(parts.after.startsWith("\nIt is a wide shot")).toBe(true);
    expect(parts.after).toContain("1. 林 — 四十岁上下。");
    // What is shown is what is sent: the parts spliced back are the ask, with
    // the mentions' backticks stripped from the words alone.
    expect(parts.before + stripStoryMentions(parts.content) + parts.after).toBe(
      storyKeyframePrompt(input),
    );
    expect(storyKeyframePrompt(input)).not.toContain("`");
  });

  it("draws a frame with no cast without asking for references", () => {
    const prompt = storyKeyframePrompt({
      aspect: "16:9",
      style: "现代都市风",
      chapter: { title: "第一章 站台" },
      act: { summary: "站台上的灯一盏一盏亮起来。" },
      keyframe: {
        content: "空站台。",
        shotSize: "wide",
        cameraMove: "static",
        angle: "eyeLevel",
      },
      cast: [],
    });
    expect(prompt).not.toContain("reference");
    expect(prompt).toContain("空站台。");
  });

  it("shoots an act between the frames that were drawn for it", () => {
    const prompt = storyActVideoPrompt({
      aspect: "16:9",
      style: "现代都市风",
      title: "第 1 幕 空站台",
      summary: "站台上的灯一盏一盏亮起来。",
      first: "雨中的站台。",
      last: "另一人转过身来。",
      middle: "灯亮了。",
      seconds: 5,
    });
    expect(prompt).toContain("about 5 seconds");
    expect(prompt).toContain("It opens on: 雨中的站台。");
    expect(prompt).toContain("It passes through: 灯亮了。");
    expect(prompt).toContain("It ends on: 另一人转过身来。");
    expect(prompt).not.toContain("{{");
  });

  it("shoots an act with nothing in the middle without saying it passes through nothing", () => {
    const prompt = storyActVideoPrompt({
      aspect: "16:9",
      style: "现代都市风",
      title: "第 1 幕 空站台",
      summary: "站台上的灯一盏一盏亮起来。",
      first: "雨中的站台。",
      last: "另一人转过身来。",
      middle: "",
      seconds: 4,
    });
    expect(prompt).not.toContain("passes through");
  });

  it("shoots a piece drawn from references without calling them frames to move between", () => {
    const prompt = storyActVideoPrompt({
      aspect: "16:9",
      style: "现代都市风",
      title: "第 1 幕 空站台",
      summary: "站台上的灯一盏一盏亮起来。",
      first: "雨中的站台。",
      last: "另一人转过身来。",
      middle: "雨中的站台。; 另一人转过身来。",
      mode: "references",
      seconds: 5,
    });
    expect(prompt).toContain("about 5 seconds");
    expect(prompt).toContain("It covers: 雨中的站台。; 另一人转过身来。");
    expect(prompt).toContain("references the shots are drawn from");
    expect(prompt).not.toContain("frames it moves between");
    expect(prompt).not.toContain("It opens on");
    expect(prompt).not.toContain("It ends on");
    expect(prompt).not.toContain("{{");
  });

  it("shoots one shot from the frame it starts on", () => {
    const prompt = storyKeyframeVideoPrompt({
      aspect: "9:16",
      style: "现代都市风",
      title: "#1",
      content: "雨中的站台，一个人立在灯下。",
      seconds: 2,
    });
    expect(prompt).toContain("about 2 seconds");
    expect(prompt).toContain("雨中的站台，一个人立在灯下。");
    expect(prompt).toContain("9:16");
    expect(prompt).not.toContain("{{");
  });

  it("carries no newline of its own, in any of them", () => {
    const written = [
      storySystemPrompt(),
      storyFactsPrompt(facts),
      storyOutlinePrompt({ ...facts, idea: "…", chapters: 1 }),
      storySplitPrompt({
        text: "…",
        part: 1,
        minutes: 1,
        total: "1:00",
        last: true,
      }),
      storySplitRepairPrompt({
        text: "…",
        part: 1,
        minutes: 1,
        total: "1:00",
        last: true,
        missing: ["…"],
      }),
      storySplitSystemPrompt(),
      storyChapterPrompt({ idea: "…", chapters: 1, number: 1 }),
      storyElementsPrompt({ chapters: [], genre: "…", style: "…" }),
      storyMergeElementsPrompt({
        groups: [{ kind: "character", name: "…", descriptions: ["…", "…"] }],
        genre: "…",
        style: "…",
      }),
      storyStoryboardPrompt({
        ...facts,
        number: 1,
        chapter: { title: "…", text: "…" },
        targetDurationMs: 1000,
        elements: [],
        shotSizes: [],
        cameraMoves: [],
        angles: [],
      }),
      storyElementMainPrompt({
        aspect: "16:9",
        style: "…",
        kind: "prop",
        name: "…",
        description: "…",
      }),
      storyElementTurnaroundPrompt({
        aspect: "16:9",
        style: "…",
        name: "…",
        description: "…",
      }),
      storyKeyframePrompt({
        aspect: "16:9",
        style: "…",
        chapter: { title: "…" },
        act: { summary: "…" },
        keyframe: {
          content: "…",
          shotSize: "wide",
          cameraMove: "static",
          angle: "eyeLevel",
        },
        cast: [],
      }),
      storyActVideoPrompt({
        aspect: "16:9",
        style: "…",
        title: "…",
        summary: "…",
        first: "…",
        last: "…",
        middle: "",
        seconds: 1,
      }),
      storyKeyframeVideoPrompt({
        aspect: "16:9",
        style: "…",
        title: "…",
        content: "…",
        seconds: 1,
      }),
    ];
    for (const words of written) {
      expect(words.endsWith("\n")).toBe(false);
      expect(words).not.toContain("{{");
    }
  });
});
