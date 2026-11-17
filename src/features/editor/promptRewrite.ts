/**
 * Rewriting a canvas image prompt into the contract its model reads.
 *
 * The protocol is read off the model that will draw the node, including the
 * deployment's default when the node names none. The material is the node's
 * own references and the place it sits on the canvas; the words it rewrites
 * are the draft in the panel, and nothing here writes or sends a media ask.
 */
import type { ModelsView, ProtocolGroups } from "../../api/models";
import {
  findNode,
  mentionNodeIds,
  type AssetId,
  type CanvasDocument,
  type GenerationInputMode,
  type GenerationSpec,
  type ResourceEntry,
  type WorkflowNode,
} from "../../shared/domain";
import { i18n } from "../../shared/i18n";
import {
  imagePromptRewriteAsk,
  imagePromptRewriteSystem,
  videoPromptRewriteAsk,
  videoPromptRewriteSystem,
} from "../../shared/prompts";
import type { ImagePromptContext } from "../../shared/prompts/image/promptContext";
import type {
  CanvasVideoInput,
  CanvasVideoInputKind,
  CanvasVideoInputRole,
  CanvasVideoPromptContext,
} from "../../shared/prompts/video/promptContext";
import {
  promptContractIssues,
  type PromptContractIssue,
} from "../../shared/prompts/promptContract";
import {
  promptRewriteGuide,
  rewritePromptText,
  type PromptRewriteGuide,
} from "../../shared/prompts/rewrite";
import { effectiveDefaultId } from "../settings/modelStore";
import { mentionToken } from "./canvas/mentions";

/** The contract a model of one capability declares, or none. */
function canvasPromptRewrite(
  view: ModelsView | null,
  protocols: ProtocolGroups | null,
  capability: "image" | "video",
  model: string | null,
): PromptRewriteGuide | null {
  if (view === null || protocols === null) return null;
  const id =
    model === null || model === ""
      ? effectiveDefaultId(view, capability)
      : model;
  const held = view.models.find((each) => each.id === id);
  if (held === undefined) return null;
  return promptRewriteGuide(protocols, capability, held.protocol);
}

/** The contract the model that will draw this node declares, or none. */
export function canvasImagePromptRewrite(
  view: ModelsView | null,
  protocols: ProtocolGroups | null,
  model: string | null,
): PromptRewriteGuide | null {
  return canvasPromptRewrite(view, protocols, "image", model);
}

/** The contract the model that will film this node declares, or none. */
export function canvasVideoPromptRewrite(
  view: ModelsView | null,
  protocols: ProtocolGroups | null,
  model: string | null,
): PromptRewriteGuide | null {
  return canvasPromptRewrite(view, protocols, "video", model);
}

/** A rewritten canvas prompt and what is wrong with it. */
export interface RewrittenCanvasPrompt {
  prompt: string;
  issues: PromptContractIssue[];
}

/**
 * One canvas node's prompt, rewritten for its model.
 *
 * A refusal is thrown as it came — the panel shows the reason whole rather
 * than turning it into a generic failure. Node tokens are addresses, so every
 * one the draft carried is checked for survival.
 */
export async function rewriteCanvasImagePrompt(input: {
  prompt: string;
  context: ImagePromptContext;
  guide: PromptRewriteGuide;
  /** The text model to ask, or none for the deployment's default. */
  model?: string | null;
  signal?: AbortSignal;
}): Promise<RewrittenCanvasPrompt> {
  const said = await rewritePromptText({
    system: imagePromptRewriteSystem(input.guide.guide),
    prompt: imagePromptRewriteAsk({
      prompt: input.prompt,
      context: input.context,
    }),
    model: input.model,
    signal: input.signal,
  });
  if (said === "") {
    throw new Error(i18n.t("editor:promptPanel.rewriteEmpty"));
  }
  return {
    prompt: said,
    issues: promptContractIssues(said, input.guide.checks, {
      sourcePrompt: input.prompt,
    }),
  };
}

/**
 * One canvas node's video prompt, rewritten for the model that will film it.
 *
 * The material is the media the node will actually travel with under the input
 * mode it is set to; node tokens are addresses, so every one the draft carried
 * is checked for survival.
 */
export async function rewriteCanvasVideoPrompt(input: {
  prompt: string;
  context: CanvasVideoPromptContext;
  guide: PromptRewriteGuide;
  /** The text model to ask, or none for the deployment's default. */
  model?: string | null;
  signal?: AbortSignal;
}): Promise<RewrittenCanvasPrompt> {
  const said = await rewritePromptText({
    system: videoPromptRewriteSystem(input.guide.guide),
    prompt: videoPromptRewriteAsk({
      prompt: input.prompt,
      context: input.context,
    }),
    model: input.model,
    signal: input.signal,
  });
  if (said === "") {
    throw new Error(i18n.t("editor:promptPanel.rewriteEmpty"));
  }
  return {
    prompt: said,
    issues: promptContractIssues(said, input.guide.checks, {
      sourcePrompt: input.prompt,
    }),
  };
}

/** A node and everything a group beside it stands for. */
function materialSources(
  canvas: CanvasDocument,
  nodeId: string,
): WorkflowNode[] {
  const found: WorkflowNode[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const source = findNode(canvas, id);
    if (source === undefined) return;
    if (source.kind !== "group") {
      found.push(source);
      return;
    }
    const members =
      canvas.groups.find((group) => group.groupId === id)?.childNodeIds ?? [];
    for (const member of members) walk(member);
  };
  walk(nodeId);
  return found;
}

/** The file a source hands along, which a director names by its output port. */
function sourceAssetId(
  source: WorkflowNode,
  sourcePort: string | undefined,
): AssetId | undefined {
  if (source.kind === "director") {
    const state = (
      source.data as {
        director?: { frameAssetId?: AssetId; blockingAssetId?: AssetId };
      }
    ).director;
    if (sourcePort === "frame") return state?.frameAssetId;
    if (sourcePort === "blocking") return state?.blockingAssetId;
    return undefined;
  }
  return (source.data as { assetId?: AssetId }).assetId;
}

/** What one input is, read off its file first and its card second. */
function sourceKind(
  source: WorkflowNode,
  entry: ResourceEntry | undefined,
): CanvasVideoInputKind | undefined {
  const mime = entry?.mime ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  switch (source.kind) {
    case "text":
      return "text";
    case "image":
      return "image";
    case "video":
    case "director":
      return "video";
    case "audio":
      return "audio";
    default:
      return undefined;
  }
}

/** The words a text node has to say: written content, or its last answer. */
function sourceText(source: WorkflowNode): string | undefined {
  const content = ((source.data as { content?: string }).content ?? "").trim();
  if (content !== "") return content;
  const slots = (
    source.data as {
      resultSlots?: {
        status?: string;
        text?: string;
        isPrimary?: boolean;
      }[];
    }
  ).resultSlots;
  const kept = slots?.find(
    (slot) =>
      slot.isPrimary === true &&
      slot.status === "succeeded" &&
      (slot.text ?? "").trim() !== "",
  )?.text;
  return kept?.trim();
}

/** What a source shows or says, in the words the canvas already holds. */
function sourceDescription(
  source: WorkflowNode,
  sourcePort: string | undefined,
  entry: ResourceEntry | undefined,
): string | undefined {
  if (source.kind === "director") {
    return sourcePort === "blocking" ? "blocking reference" : "frame";
  }
  if (source.kind === "text") {
    const content = sourceText(source);
    return content === undefined ? undefined : content.split("\n", 1)[0];
  }
  const said = entry?.keyword?.trim() || entry?.note?.trim();
  return said === undefined || said === "" ? source.kind : said;
}

/** The role a wired input's landing port gives a picture. */
function roleForPort(portId: string): CanvasVideoInputRole | undefined {
  switch (portId) {
    case "firstFrame":
      return "firstFrame";
    case "lastFrame":
      return "lastFrame";
    case "images":
    case "videos":
    case "audios":
    case "audio":
    case "video":
      return "reference";
    default:
      return undefined;
  }
}

/** A number a parameter holds, whether it was stored as one or as digits. */
function numberParam(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The material a canvas video node's rewrite is told about.
 *
 * Only what the node's input mode actually takes travels: the wiring, the list
 * by hand, or the nodes the prompt names — the same choice the server makes.
 * A text node mentioned in the words is kept as a text input so its token can
 * be understood; text merely wired in is left out, since it is not part of the
 * draft this rewrite replaces.
 */
export function canvasVideoPromptContext(input: {
  canvas: CanvasDocument;
  node: WorkflowNode;
  spec: GenerationSpec;
  resources: ReadonlyMap<AssetId, ResourceEntry>;
  inputMode: GenerationInputMode;
  prompt: string;
}): CanvasVideoPromptContext {
  const inputs = new Map<string, CanvasVideoInput>();
  const add = (
    source: WorkflowNode,
    role: CanvasVideoInputRole,
    sourcePort?: string,
    token?: string,
  ) => {
    const assetId = sourceAssetId(source, sourcePort);
    const entry =
      assetId === undefined ? undefined : input.resources.get(assetId);
    const kind = sourceKind(source, entry);
    if (kind === undefined) return;
    if (kind !== "text" && assetId === undefined) return;
    const description = sourceDescription(source, sourcePort, entry);
    if (kind === "text" && description === undefined) return;
    const previous = inputs.get(source.id);
    if (previous !== undefined) {
      if (previous.token === undefined && token !== undefined) {
        previous.token = token;
      }
      return;
    }
    inputs.set(source.id, {
      kind,
      role,
      name: source.title,
      ...(description === undefined ? {} : { description }),
      ...(token === undefined ? {} : { token }),
    });
  };

  if (input.inputMode === "upstream") {
    for (const edge of input.canvas.edges) {
      if (edge.target.nodeId !== input.node.id) continue;
      const role = roleForPort(edge.target.portId);
      if (role === undefined) continue;
      for (const source of materialSources(input.canvas, edge.source.nodeId)) {
        add(source, role, edge.source.portId);
      }
    }
  } else if (input.inputMode === "manual") {
    for (const nodeId of input.spec.referenceNodeIds) {
      for (const source of materialSources(input.canvas, nodeId)) {
        add(source, "reference");
      }
    }
  } else {
    for (const nodeId of mentionNodeIds(input.prompt)) {
      for (const source of materialSources(input.canvas, nodeId)) {
        add(source, "reference", undefined, mentionToken(nodeId));
      }
    }
  }

  const ratio = input.spec.params.ratio;
  const resolution = input.spec.params.resolution;
  const seconds = numberParam(input.spec.params.seconds);
  const pictures =
    input.spec.params.mode === "reference" ? "references" : "frames";
  const material = [...inputs.values()];
  if (pictures === "references") {
    // In reference mode a picture is a reference whatever port it arrived on:
    // that is how the provider will read it, so it is how the words should.
    for (const entry of material) {
      if (entry.kind === "image") entry.role = "reference";
    }
  }
  return {
    kind: "canvas",
    pictures,
    ...(typeof ratio === "string" && ratio.trim() !== ""
      ? { aspect: ratio }
      : {}),
    ...(typeof resolution === "string" && resolution.trim() !== ""
      ? { resolution }
      : {}),
    ...(seconds === undefined ? {} : { seconds }),
    inputs: material,
  };
}
