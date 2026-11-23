/**
 * The material a canvas video prompt is written from, as the rewrite reads it.
 *
 * A canvas has no board or cast behind its words the way a telling does: what
 * it has is the media the node will travel with, the role each piece plays,
 * and the shape and length of the clip. This is that, so a model asked to
 * rewrite the words can keep every reference and every node token they carry
 * rather than guess at them.
 */

/** What one input is, as the provider will read it. */
export type CanvasVideoInputKind = "image" | "video" | "audio" | "text";

/** What one picture is for: an end of the clip, or a reference to keep. */
export type CanvasVideoInputRole = "firstFrame" | "lastFrame" | "reference";

/** One piece of material the clip travels with. */
export interface CanvasVideoInput {
  kind: CanvasVideoInputKind;
  role: CanvasVideoInputRole;
  /** 1-based place among the media of its own kind, in travel order. */
  position?: number;
  name: string;
  /** What it shows or says, where the canvas knows. */
  description?: string;
  /** The canvas node token this input stands for, where the prompt names it. */
  token?: string;
}

/** What a canvas node's video prompt is rewritten from. */
export interface CanvasVideoPromptContext {
  kind: "canvas";
  /** Whether pictures travel as the clip's frames or as references. */
  pictures: "frames" | "references";
  aspect?: string;
  resolution?: string;
  seconds?: number;
  inputs: CanvasVideoInput[];
}
