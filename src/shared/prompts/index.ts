/**
 * The words this client asks a model with, kept out of the code that sends them.
 *
 * A prompt written into a component is a sentence nobody thinks to look for when
 * the answer coming back is wrong, and one kept under `shared/prompts/` is a file
 * a reader can open, change, and read again without first finding the place that
 * happens to send it. Each one is imported as raw text, so the words a build asks
 * with are the words that build was tested with: nothing is fetched at runtime,
 * and a prompt cannot depend on a network that has nothing to do with it.
 *
 * The Rust side keeps its own set under `src-tauri/prompts/`, embedded into the
 * binary the same way. The two deliberately do not share files. They are built by
 * different tools into different artifacts, and a template that had to cross that
 * boundary would need a server running to be readable at all.
 */
import { Environment } from "nunjucks";

import { formatDuration, stripStoryMentions } from "../domain/story";
import type { StoryAspect, StoryElementKind } from "../domain";
import ask from "./assistant/ask.tmpl?raw";
import answerSystem from "./assistant/answer-system.tmpl?raw";
import contextBlock from "./assistant/context-block.tmpl?raw";
import history from "./assistant/history.tmpl?raw";
import historyLine from "./assistant/history-line.tmpl?raw";
import rewriteSystem from "./assistant/rewrite-system.tmpl?raw";
import describeFraming from "./editor/describe-framing.tmpl?raw";
import describeDefault from "./editor/describe-default.tmpl?raw";
import storySystem from "./story/system.tmpl?raw";
import storyFacts from "./story/facts.tmpl?raw";
import storyOutline from "./story/outline.tmpl?raw";
import storySplit from "./story/split.tmpl?raw";
import storyElements from "./story/elements.tmpl?raw";
import storyStoryboard from "./story/storyboard.tmpl?raw";
import storyElementMain from "./story/element-main.tmpl?raw";
import storyElementTurnaround from "./story/element-turnaround.tmpl?raw";
import storyKeyframe from "./story/keyframe.tmpl?raw";
import storyActVideo from "./story/act-video.tmpl?raw";
import storyActMusic from "./story/act-music.tmpl?raw";
import storyKeyframeVideo from "./story/keyframe-video.tmpl?raw";

/**
 * The engine, configured once.
 *
 * Autoescaping is off because a prompt is plain words rather than a page: text
 * quoted into one has to arrive as it was written, and a reader's ampersand or
 * angle bracket turned into a character reference would be asking for something
 * else. Nothing rendered here is ever written into HTML, which is the only thing
 * escaping would have protected.
 */
const engine = new Environment(null, { autoescape: false });

/**
 * One template's words, with `values` filling the holes in them.
 *
 * A value the template does not name is ignored, and one the template names and
 * `values` does not carry is written as nothing: a hole in a prompt is a thing a
 * reader can see in the answer, and a question that never got asked is not.
 *
 * A template that does not parse throws. These are part of the build, so that is
 * a fault in the build and is not papered over here; the tests beside this file
 * read every one of them.
 */
function render(source: string, values: object): string {
  // A file that ends with a line break is what an editor writes and what a reader
  // expects to see. A newline at the end of a prompt is neither.
  return engine.renderString(source.replace(/\n$/, ""), values);
}

/**
 * What an ask is told about the cards it was given.
 *
 * A standing instruction rather than a per-question one, and the reason an ask
 * that cannot find an answer says so instead of filling the gap.
 */
export function answerSystemPrompt(): string {
  return render(answerSystem, {});
}

/**
 * What a rewrite is told, which is narrower on purpose: the text comes back and
 * nothing else, because it is going onto a card rather than into a conversation.
 */
export function rewriteSystemPrompt(): string {
  return render(rewriteSystem, {});
}

/**
 * The question a "describe this picture" dialog starts with, which a reader can
 * change before sending it.
 */
export function describeDefaultPrompt(): string {
  return render(describeDefault, {});
}

/**
 * How the answer to that question is framed.
 *
 * Sent beside it rather than left to the standing instruction for written
 * answers, which says how to be answered in general: this ask wants one
 * particular thing, words a picture could be made from and nothing around them.
 * A description that arrives wrapped in an announcement of itself has to be
 * unwrapped by hand before it is any use as a prompt.
 */
export function describeFramingPrompt(): string {
  return render(describeFraming, {});
}

/**
 * One line of a conversation, named for who said it.
 *
 * Rendered one line at a time rather than as part of the block because what fits
 * inside the budget is measured before anything is sent, and measuring the
 * rendered line is the only way the measure and the message can agree.
 */
export function historyLinePrompt(speaker: string, text: string): string {
  return render(historyLine, { speaker, text });
}

/**
 * The last few things said, as the block a question travels with.
 *
 * The lines arrive already composed by {@link historyLinePrompt}, oldest first.
 */
export function historyPrompt(lines: readonly string[]): string {
  return render(history, { lines });
}

/** One card's text, quoted under the title it is read by. */
export function contextBlockPrompt(title: string, content: string): string {
  return render(contextBlock, { title, content });
}

/**
 * The parts of a question, in the order they are read: what the cards say, what
 * was said before, and what is being asked now.
 *
 * The empties are dropped before they arrive rather than inside the template, so
 * a question asked with no cards and no memory does not travel with two
 * separators and nothing between them.
 */
export function askPrompt(parts: readonly string[]): string {
  return render(ask, { parts: parts.filter((part) => part !== "") });
}

// -----------------------------------------------------------------------------
// The story room
// -----------------------------------------------------------------------------

/**
 * The standing instruction a story's written answers are asked under.
 *
 * Sent as the `system` half of the request rather than folded into the prompt,
 * because it says how every answer of this kind is written: a shape, and
 * nothing that is not in it.
 */
export function storySystemPrompt(): string {
  return render(storySystem, {});
}

/**
 * The two things every picture of a story is drawn with.
 *
 * The frame, since a picture that does not say what shape it is gets whatever
 * the provider feels like, and the look, since a cast drawn in five different
 * styles is five different films.
 */
export interface StoryLook {
  aspect: StoryAspect;
  style: string;
}

/** What a written step is told about the telling it is writing. */
export interface StoryFacts extends StoryLook {
  genre: string;
  totalDurationMs: number;
}

/**
 * The standing facts of the telling, as the text prompts open with them.
 *
 * Composed by the constructors rather than included by the templates: a
 * template that had to know another template's name would be a file to change
 * whenever this block does, and the block is one thing in one place.
 */
export function storyFactsPrompt(facts: StoryFacts): string {
  return render(storyFacts, {
    aspect: facts.aspect,
    genre: facts.genre,
    style: facts.style,
    total: formatDuration(facts.totalDurationMs),
  });
}

/** The premise written into chapters, which is the outline step's ask. */
export function storyOutlinePrompt(
  input: StoryFacts & { idea: string; chapters: number },
): string {
  return [storyFactsPrompt(input), render(storyOutline, input)].join("\n\n");
}

/**
 * One part of a manuscript written into one chapter.
 *
 * The index and the total are carried so the model knows where in the whole it
 * is standing: a part read as the first reads differently from the last.
 */
export function storySplitPrompt(input: {
  text: string;
  index: number;
  total: number;
  genre: string;
  style: string;
}): string {
  return render(storySplit, input);
}

/**
 * What the telling is made of: its characters, places and things.
 *
 * A telling whose chapters do not fit in one ask is read a part at a time, and
 * a part is told which part it is: what it names is added to what earlier parts
 * found rather than standing for the whole cast. Chapters travel under the
 * telling's own numbers even where a part holds only some of them, because the
 * answer says which chapter each thing was noticed in by that number.
 */
export function storyElementsPrompt(input: {
  chapters: Array<{ number: number; title: string; synopsis: string }>;
  genre: string;
  style: string;
  part?: number;
  total?: number;
}): string {
  return render(storyElements, input);
}

/**
 * One episode boarded as acts and shots.
 *
 * The elements arrive as the story holds them — names and descriptions, in the
 * telling's own words — because the board has to be written in names the cast
 * can be matched back to, and a name the model invented would match nothing.
 */
export function storyStoryboardPrompt(
  input: StoryFacts & {
    number: number;
    chapter: { title: string; synopsis: string };
    targetDurationMs: number;
    elements: Array<{
      kind: StoryElementKind;
      name: string;
      description: string;
    }>;
    shotSizes: readonly string[];
    cameraMoves: readonly string[];
    angles: readonly string[];
  },
): string {
  return [
    storyFactsPrompt(input),
    render(storyStoryboard, {
      ...input,
      elements: storyElementsList(input.elements),
      seconds: Math.round(input.targetDurationMs / 1000),
    }),
  ].join("\n\n");
}

function storyElementsList(
  elements: Array<{
    kind: StoryElementKind;
    name: string;
    description: string;
  }>,
): string {
  return elements
    .map(
      (element) =>
        `- ${element.name} (${element.kind}) — ${element.description}`,
    )
    .join("\n");
}

/** A character, a place or a thing, drawn on its own. */
export function storyElementMainPrompt(
  input: StoryLook & {
    kind: StoryElementKind;
    name: string;
    description: string;
  },
): string {
  return render(storyElementMain, input);
}

/** A character's four views, on one picture, which is how they stay the same person. */
export function storyElementTurnaroundPrompt(
  input: StoryLook & { name: string; description: string },
): string {
  return render(storyElementTurnaround, input);
}

/** What one frame's ask is written from: the look, the shot, and the pictures
 * that travel with it. */
export interface StoryKeyframePromptInput extends StoryLook {
  chapter: { title: string };
  act: { summary: string };
  keyframe: {
    content: string;
    shotSize: string;
    cameraMove: string;
    angle: string;
  };
  cast: Array<{ name: string; description: string }>;
}

/** The mark the content is rendered between so the words around it can be read
 * apart again; a character no prose carries. */
const CONTENT_SEAM = "\u0000";

/**
 * One frame's ask in two: the template's own words, and the hole the shot's
 * content is written into.
 *
 * The room shows a reader the prompt exactly as it will be sent — the fixed
 * scaffolding, the shot's own words, the numbered references and the look —
 * and the part of it a reader edits is the content alone. Reading the words
 * around the content apart is what that display is made of.
 */
export function storyKeyframePromptParts(input: StoryKeyframePromptInput): {
  before: string;
  content: string;
  after: string;
} {
  const whole = render(storyKeyframe, {
    ...input,
    summary: input.act.summary,
    content: CONTENT_SEAM,
    shotSize: input.keyframe.shotSize,
    cameraMove: input.keyframe.cameraMove,
    angle: input.keyframe.angle,
  });
  const at = whole.indexOf(CONTENT_SEAM);
  return {
    before: whole.slice(0, at),
    content: input.keyframe.content,
    after: whole.slice(at + CONTENT_SEAM.length),
  };
}

/**
 * One frame of a board, drawn with the cast that stands in it.
 *
 * The cast is written into the prompt in the order its pictures travel, so the
 * numbered references the model reads are the numbered references it is given.
 * The shot's own words travel without the backticks that mark their mentions:
 * those are the room's own sign for which pictures ride along, and the model is
 * owed the sentence they were written around.
 */
export function storyKeyframePrompt(input: StoryKeyframePromptInput): string {
  const parts = storyKeyframePromptParts(input);
  return parts.before + stripStoryMentions(parts.content) + parts.after;
}

/**
 * One act filmed whole, moving between the frames that were drawn for it —
 * or, when the act outruns what one clip may be, one of the pieces it is
 * filmed in, told apart by its place and asked to end where the next begins.
 *
 * A piece whose pictures are references rather than frames says so in `mode`:
 * then `middle` carries the words of every shot the piece covers, and the
 * prompt asks for a shot drawn from those pictures instead of one moving
 * between them. Left off, the words describe frames as they always have.
 */
export function storyActVideoPrompt(
  input: StoryLook & {
    title: string;
    summary: string;
    first: string;
    last: string;
    middle: string;
    seconds: number;
    /** How the pictures travel: frames to move between, or references. */
    mode?: "frames" | "references";
    /** Its place among the pieces, when the act is filmed in several. */
    part?: number;
    total?: number;
  },
): string {
  return render(storyActVideo, {
    ...input,
    references: input.mode === "references",
  });
}

/** One shot filmed, starting from the frame that was drawn for it. */
export function storyKeyframeVideoPrompt(
  input: StoryLook & {
    title: string;
    content: string;
    seconds: number;
  },
): string {
  return render(storyKeyframeVideo, input);
}

/** An act's music and sound, under the words and the pictures. */
export function storyActMusicPrompt(
  input: StoryLook & {
    genre: string;
    title: string;
    summary: string;
    music: string;
    sfx: string;
    ambience: string;
    seconds: number;
  },
): string {
  return render(storyActMusic, input);
}
