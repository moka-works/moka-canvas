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
  imagePromptRewriteAsk,
  imagePromptRewriteSystem,
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
  storyRevisionPrompt,
  storySystemPrompt,
  videoPromptRewriteAsk,
  videoPromptRewriteSystem,
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
    expect(prompt).toContain('"forms"');
    expect(prompt).toContain(
      "fully self-contained, static, precise and unambiguous",
    );
    expect(prompt).toContain(
      "upper garment, lower garment, socks and footwear",
    );
    expect(prompt).toContain("every accessory and item worn or carried");
    expect(prompt).toContain("never refer to another form");
    expect(prompt).toContain('do not use "或", "或者", "or", "either"');
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

  it("keeps a scene to one place and each static state to its own form", () => {
    const prompt = storyElementsPrompt({
      chapters: [
        { number: 1, title: "第一章 站台", text: "他在站台上等列车。" },
      ],
      genre: "对白剧情",
      style: "现代都市风",
    });
    // A visually different hour or weather is another form of the same place,
    // not another place and not a temporal alternative inside one description.
    expect(prompt).toContain("one place to an entry");
    expect(prompt).toContain(
      "The same place at another hour or in other weather is still the one scene entry",
    );
    expect(prompt).toContain(
      "each visually different state is its own form with a complete static description",
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
    // A scene and a prop are reference pictures for the place and the thing
    // alone: anyone the telling follows is drawn by the shots they stand in,
    // so a description that puts people in a place or a thing would hand every
    // frame figures it never asked for.
    expect(prompt).toContain("describe the place alone: put no one in it");
    expect(prompt).toContain(
      "describing the thing alone: no one holds, wears or stands beside it",
    );
    expect(prompt).toContain(
      "keep it out of the cast and out of every scene's description",
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

  it("merges repeated readings without combining incompatible appearances", () => {
    const prompt = storyMergeElementsPrompt({
      groups: [
        {
          kind: "character",
          name: "林玉兰",
          readings: [
            {
              description: "五十岁，黑色短发，穿深灰上装和黑色长裤。",
              forms: [
                { name: "围裙", description: "五十岁，黑色短发，系蓝色围裙。" },
              ],
            },
            { description: "五十岁，黑色短发，穿深蓝上装和黑色长裤。" },
          ],
        },
        {
          kind: "scene",
          name: "便利店",
          readings: [
            { description: "深夜仍亮着灯的店面。" },
            { description: "收银台后的货架摆得很满。" },
          ],
        },
      ],
      genre: "对白剧情",
      style: "现代都市风",
      part: 1,
      total: 2,
    });
    expect(prompt).toContain('- character "林玉兰"');
    expect(prompt).toContain("  - Default appearance: 五十岁，黑色短发");
    expect(prompt).toContain('    - Additional form "围裙"');
    expect(prompt).toContain("穿深蓝上装和黑色长裤");
    expect(prompt).toContain('- scene "便利店"');
    expect(prompt).toContain(
      "Keep visually incompatible appearances as separate forms",
    );
    expect(prompt).toContain(
      "fully self-contained, static, precise and unambiguous",
    );
    expect(prompt).toContain(
      "upper garment, lower garment, socks and footwear",
    );
    expect(prompt).toContain("add or leave out an entry");
    expect(prompt).toContain("never voice, habits, manner");
    expect(prompt).toContain(
      "describing the place alone with no person standing in it",
    );
    expect(prompt).toContain(
      "describing the thing alone with no person holding or wearing it",
    );
    expect(prompt).toContain("This is merge 1 of 2");
    expect(prompt).toContain('"forms"');
    expect(prompt).not.toContain("{{");
  });

  it("boards a chapter with the names it must be written in", () => {
    const prompt = storyStoryboardPrompt({
      ...facts,
      number: 2,
      chapter: { title: "第二章 车厢", text: "车厢比站台更暗。" },
      targetDurationMs: 60_000,
      maxVideoSeconds: 8,
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
    expect(prompt).toContain("between 400 ms and 8 seconds");
    expect(prompt).toContain("at most 8 seconds");
    expect(prompt).toContain("close-up");
    expect(prompt).toContain("Every character who speaks");
    expect(prompt).toContain("mediumClose, wide");
    expect(prompt).toContain("static, pushIn");
    expect(prompt).toContain("eyeLevel, high");
    expect(prompt).toContain('"keyframes"');
    expect(prompt).not.toContain("{{");
  });

  it("revises a board from the two outlines, by the ids it was given", () => {
    const prompt = storyRevisionPrompt({
      ...facts,
      number: 2,
      before: { title: "第二章 车厢", text: "车厢比站台更暗。" },
      after: { title: "第二章 车厢", text: "车厢的灯忽然全灭了。" },
      targetDurationMs: 60_000,
      elements: [
        { kind: "character", name: "林", description: "四十岁上下。" },
      ],
      acts: [
        {
          id: "act-1",
          title: "第 1 幕",
          summary: "灯还亮着。",
          frames: [
            {
              id: "frame-1",
              title: "#1",
              shotSize: "wide",
              cameraMove: "static",
              angle: "eyeLevel",
              durationMs: 3_000,
              content: "`林`坐在灯下。",
              dialogue: [
                { id: "line-1", speaker: "林", text: "车已经停运了。" },
              ],
              made: "frame drawn",
            },
          ],
        },
      ],
      shotSizes: ["wide"],
      cameraMoves: ["static"],
      angles: ["eyeLevel"],
    });
    expect(prompt).toContain("车厢比站台更暗。");
    expect(prompt).toContain("车厢的灯忽然全灭了。");
    expect(prompt).toContain("Act act-1");
    expect(prompt).toContain("Frame frame-1");
    expect(prompt).toContain("[line-1] 林: 车已经停运了。");
    expect(prompt).toContain("Already made: frame drawn");
    expect(prompt).toContain('"needsRebuild"');
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
    expect(prompt).toContain("exactly one static form");
    expect(prompt).toContain("do not introduce alternatives");
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
    expect(prompt).toContain("no person anywhere in the frame");
    expect(prompt).toContain("the place stands empty");
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
    expect(prompt).toContain(
      "no person holding, wearing or standing beside it",
    );
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
    expect(prompt).toContain("approximately 16:9 horizontal landscape");
    expect(prompt).toContain("left approximately 2/5 (40%)");
    expect(prompt).toContain("upper-body and face close-up");
    expect(prompt).toContain("right approximately 3/5 (60%)");
    expect(prompt).toContain("front, side and back");
    expect(prompt).toContain("three separate full-body views");
    expect(prompt).toContain("no overlap");
    expect(prompt).toContain("exactly one static form");
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
    // The picture is drawn from the still frame; the camera's travel belongs
    // to the clip's ask and is not part of it.
    expect(prompt).not.toContain("pushIn");
    expect(prompt).toContain("one held moment");
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
        angle: "eyeLevel",
      },
      cast: [],
    });
    expect(prompt).not.toContain("reference");
    expect(prompt).toContain("空站台。");
  });

  it("shoots an act moment by moment, each at the second it opens", () => {
    const prompt = storyActVideoPrompt({
      aspect: "16:9",
      style: "现代都市风",
      title: "第 1 幕 空站台",
      summary: "站台上的灯一盏一盏亮起来。",
      shots: [
        { at: 0, content: "雨中的站台。", move: "static" },
        { at: 2, content: "灯亮了。", move: "static" },
        { at: 4, content: "另一人转过身来。", move: "static" },
      ],
      seconds: 5,
    });
    expect(prompt).toContain("about 5 seconds");
    expect(prompt).toContain("At 0s, camera static: 雨中的站台。");
    expect(prompt).toContain("At 2s, camera static: 灯亮了。");
    expect(prompt).toContain("At 4s, camera static: 另一人转过身来。");
    expect(prompt).not.toContain("{{");
  });

  it("carries on from the frame of the act before when asked", () => {
    const base = {
      aspect: "16:9" as const,
      style: "现代都市风",
      title: "第 1 幕 空站台",
      summary: "站台上的灯一盏一盏亮起来。",
      shots: [{ at: 0, content: "雨中的站台。", move: "static" }],
      seconds: 5,
    };
    expect(storyActVideoPrompt(base)).not.toContain("opens on the last frame");
    expect(storyActVideoPrompt({ ...base, continues: true })).toContain(
      "opens on the last frame",
    );
  });

  it("films each moment from what moves in it, after the still frame it opens on", () => {
    const prompt = storyActVideoPrompt({
      aspect: "16:9",
      style: "现代都市风",
      title: "第 1 幕 空站台",
      summary: "站台上的灯一盏一盏亮起来。",
      shots: [
        {
          at: 0,
          content: "雨中的站台。",
          motion: "雨丝落下，灯一盏一盏亮起来。",
          move: "pushIn",
        },
      ],
      seconds: 5,
    });
    expect(prompt).toContain(
      "At 0s, camera pushIn: 雨中的站台。 雨丝落下，灯一盏一盏亮起来。",
    );
    expect(prompt).toContain("what moves within it");
  });

  it("puts the lines an act says under the moment each is spoken in", () => {
    const prompt = storyActVideoPrompt({
      aspect: "16:9",
      style: "现代都市风",
      title: "第 1 幕 空站台",
      summary: "站台上的灯一盏一盏亮起来。",
      shots: [
        {
          at: 0,
          content: "雨中的站台。",
          move: "static",
          dialogue: [
            {
              id: "line-1",
              speaker: "林",
              text: "车已经停运了。",
              tone: "平静",
            },
          ],
        },
        {
          at: 3,
          content: "另一人转过身来。",
          move: "static",
          dialogue: [{ id: "line-2", speaker: "", text: "远处传来一声汽笛。" }],
        },
      ],
      seconds: 5,
    });
    expect(prompt).toContain(
      'At 0s, camera static: 雨中的站台。 林 (平静): "车已经停运了。"',
    );
    expect(prompt).toContain(
      'At 3s, camera static: 另一人转过身来。 "远处传来一声汽笛。"',
    );
    // The lines are not a paragraph of their own: each stands with the moment
    // that says it, and the instruction keeps it there.
    expect(prompt).not.toContain("Said in it");
    expect(prompt).toContain("spoken inside the moment it stands with");
  });

  it("says nothing about words an act does not say", () => {
    const prompt = storyActVideoPrompt({
      aspect: "16:9",
      style: "现代都市风",
      title: "第 1 幕 空站台",
      summary: "站台上的灯一盏一盏亮起来。",
      shots: [
        {
          at: 0,
          content: "雨中的站台。",
          move: "static",
          dialogue: [{ id: "line-1", speaker: "林", text: "   " }],
        },
        { at: 2, content: "另一人转过身来。", move: "static" },
      ],
      seconds: 4,
    });
    expect(prompt).not.toContain('"');
    expect(prompt).not.toContain("mouths move");
  });

  it("shoots a piece drawn from references without calling them frames to move between", () => {
    const prompt = storyActVideoPrompt({
      aspect: "16:9",
      style: "现代都市风",
      title: "第 1 幕 空站台",
      summary: "站台上的灯一盏一盏亮起来。",
      shots: [
        { at: 0, content: "雨中的站台。", move: "static" },
        { at: 2, content: "另一人转过身来。", move: "static" },
      ],
      mode: "references",
      seconds: 5,
    });
    expect(prompt).toContain("about 5 seconds");
    expect(prompt).toContain("At 0s, camera static: 雨中的站台。");
    expect(prompt).toContain("At 2s, camera static: 另一人转过身来。");
    expect(prompt).toContain("references the shots are drawn from");
    expect(prompt).not.toContain("frames it moves between");
    expect(prompt).not.toContain("{{");
  });

  it("asks for a piece of words alone when no picture travels", () => {
    const prompt = storyActVideoPrompt({
      aspect: "16:9",
      style: "现代都市风",
      title: "第 1 幕 空站台",
      summary: "站台上的灯一盏一盏亮起来。",
      shots: [{ at: 0, content: "灯灭了。", move: "static" }],
      mode: "words",
      seconds: 4,
    });
    expect(prompt).toContain("about 4 seconds");
    expect(prompt).toContain("At 0s, camera static: 灯灭了。");
    expect(prompt).toContain("No pictures are given");
    expect(prompt).not.toContain("frames it moves between");
    expect(prompt).not.toContain("references the shots are drawn from");
  });

  it("shoots one shot from the frame it starts on", () => {
    const prompt = storyKeyframeVideoPrompt({
      aspect: "9:16",
      style: "现代都市风",
      title: "#1",
      content: "雨中的站台，一个人立在灯下。",
      move: "pushIn",
      seconds: 2,
    });
    expect(prompt).toContain("about 2 seconds");
    expect(prompt).toContain("雨中的站台，一个人立在灯下。");
    expect(prompt).toContain("9:16");
    expect(prompt).not.toContain("{{");
    expect(prompt).not.toContain("Said in it");
  });

  it("films one shot from its own motion and camera move", () => {
    const prompt = storyKeyframeVideoPrompt({
      aspect: "9:16",
      style: "现代都市风",
      title: "#1",
      content: "雨中的站台，一个人立在灯下。",
      motion: "她抬头看向站牌。",
      move: "handheld",
      seconds: 2,
    });
    expect(prompt).toContain("camera handheld: 雨中的站台，一个人立在灯下。");
    expect(prompt).toContain("What happens during it: 她抬头看向站牌。");
  });

  it("leaves the motion line out of a shot held still", () => {
    const prompt = storyKeyframeVideoPrompt({
      aspect: "9:16",
      style: "现代都市风",
      title: "#1",
      content: "空站台。",
      move: "static",
      seconds: 2,
    });
    expect(prompt).not.toContain("What happens during it");
  });

  it("puts a shot's lines into its own clip, with the way they are said", () => {
    const prompt = storyKeyframeVideoPrompt({
      aspect: "9:16",
      style: "现代都市风",
      title: "#1",
      content: "雨中的站台，一个人立在灯下。",
      move: "pushIn",
      seconds: 2,
      dialogue: [
        { id: "line-1", speaker: "林", text: "车已经停运了。", tone: "低声" },
      ],
    });
    expect(prompt).toContain('Said in it: 林 (低声): "车已经停运了。"');
    expect(prompt).toContain("mouth moves with these words");
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
        groups: [
          {
            kind: "character",
            name: "…",
            readings: [{ description: "…" }, { description: "…" }],
          },
        ],
        genre: "…",
        style: "…",
      }),
      storyStoryboardPrompt({
        ...facts,
        number: 1,
        chapter: { title: "…", text: "…" },
        targetDurationMs: 1000,
        maxVideoSeconds: 60,
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
          angle: "eyeLevel",
        },
        cast: [],
      }),
      storyActVideoPrompt({
        aspect: "16:9",
        style: "…",
        title: "…",
        summary: "…",
        shots: [{ at: 0, content: "…", move: "static" }],
        seconds: 1,
      }),
      storyKeyframeVideoPrompt({
        aspect: "16:9",
        style: "…",
        title: "…",
        content: "…",
        move: "static",
        seconds: 1,
      }),
    ];
    for (const words of written) {
      expect(words.endsWith("\n")).toBe(false);
      expect(words).not.toContain("{{");
    }
  });

  it("asks a rewrite under the model's own contract and the rules that hold whatever it says", () => {
    const system = videoPromptRewriteSystem("Write the body in English.");
    expect(system).toContain("Write the body in English.");
    expect(system).toContain("Keep every spoken line exactly as written");
    expect(system).toContain("Keep every node token written as `@[node:...]`");
    expect(system).toContain(
      "the opening frame, the closing frame, or a reference",
    );
    expect(system).toContain("tie every person, place, or thing it carries");
    expect(system).toContain("Output the rewritten prompt alone");
    expect(system.endsWith("\n")).toBe(false);
  });

  it("hands a rewrite the material and the words as they stand", () => {
    const prompt = videoPromptRewriteAsk({
      prompt: "Shoot this shot.",
      context: {
        kind: "shot",
        aspect: "9:16",
        style: "live action",
        seconds: 5,
        ends: { first: true, last: false, references: false },
        shots: [{ start: 0, text: "A bus stop." }],
        cast: [{ name: "林", ref: "S1", kind: "character", description: "…" }],
        dialogue: [{ speaker: "林", ref: "S1", text: "车已经停运了。" }],
      },
    });
    expect(prompt).toContain("Shoot this shot.");
    expect(prompt).toContain('"ref": "S1"');
    expect(prompt).toContain("车已经停运了。");
    // The shot's opening second travels with the material and is named as a
    // fact the rewrite keeps.
    expect(prompt).toContain('"start": 0');
    expect(prompt).toContain("every shot with the second it opens at");
    expect(prompt).not.toContain("{{");
  });

  it("says the material is absent rather than leaving a hole", () => {
    const prompt = videoPromptRewriteAsk({ prompt: "Shoot this shot." });
    expect(prompt).toContain("(none)");
  });

  it("hands a canvas video rewrite the media and node tokens it travels with", () => {
    const prompt = videoPromptRewriteAsk({
      prompt: "Film @[node:plate] as the opening frame.",
      context: {
        kind: "canvas",
        pictures: "frames",
        aspect: "16:9",
        seconds: 5,
        inputs: [
          {
            kind: "image",
            role: "firstFrame",
            position: 1,
            name: "Opening",
            description: "a lantern over a quiet lake",
            token: "@[node:plate]",
          },
        ],
      },
    });
    expect(prompt).toContain("Film @[node:plate] as the opening frame.");
    expect(prompt).toContain('"role": "firstFrame"');
    expect(prompt).toContain('"position": 1');
    expect(prompt).toContain('"token": "@[node:plate]"');
    expect(prompt).not.toContain("{{");
  });

  it("asks an image rewrite under the model's own contract", () => {
    const system = imagePromptRewriteSystem(
      "Describe the frame as a photograph.",
    );
    expect(system).toContain("Describe the frame as a photograph.");
    expect(system).toContain("Keep every node token written as `@[node:...]`");
    expect(system).toContain("listed in the order they are attached");
    expect(system).toContain("tie it to that reference by its name");
    expect(system).toContain("Output the rewritten prompt alone");
    expect(system.endsWith("\n")).toBe(false);
  });

  it("hands an image rewrite its material and the words as they stand", () => {
    const prompt = imagePromptRewriteAsk({
      prompt: "Paint @[node:a] beside @[node:b].",
      context: {
        kind: "canvas",
        mode: "generate",
        aspect: "16:9",
        references: [{ position: 1, name: "林", token: "@[node:a]" }],
      },
    });
    expect(prompt).toContain("Paint @[node:a] beside @[node:b].");
    expect(prompt).toContain('"position": 1');
    expect(prompt).toContain('"token": "@[node:a]"');
    expect(prompt).not.toContain("{{");
  });
});
