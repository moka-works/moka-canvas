/**
 * The material an image prompt is written from, as the rewrite step reads it.
 *
 * A prompt's words are one reading of a frame, an element, or a canvas node;
 * this is the material itself, so a model asked to rewrite the words into
 * another shape can keep every fact they carried rather than guess at them.
 * Nothing here is stored in a document: it is built where the ask is planned
 * and travels with the rewrite.
 */
import type { StoryElementKind } from "../../domain/types";

/** One picture the ask travels with, as the material names it. */
export interface ImagePromptReference {
  name: string;
  description?: string;
  /** The canvas node token this picture stands for, where there is one. */
  token?: string;
}

/** What an image prompt is: a frame, an element's picture, or a canvas node. */
export interface ImagePromptContext {
  kind: "frame" | "element" | "canvas";
  /** Whether the ask draws a new picture or changes one it is given. */
  mode: "generate" | "edit" | "reference";
  aspect?: string;
  style?: string;
  references: ImagePromptReference[];
  /** The shot a frame's picture is drawn from. */
  frame?: {
    chapter?: string;
    act?: string;
    content: string;
    shotSize?: string;
    cameraMove?: string;
    angle?: string;
  };
  /** The element a picture is of, and which view it is. */
  element?: {
    kind: StoryElementKind;
    name: string;
    description: string;
    view: "main" | "turnaround";
  };
}
