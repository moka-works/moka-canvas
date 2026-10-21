import { ApiError } from "../../../api";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useEditorStore } from "../../editor/stores/editorStore";
import { useClipStore } from "../../clip/stores/clipStore";
import { useAssetsStore } from "../../assets/stores/assetsStore";
import { useStoryStore } from "../../story/stores/storyStore";
import type { StoryStep } from "../../../shared/domain";
import { requestQuestion } from "./interaction";
import type { AppToolAnswer, PlanItem } from "./types";

/** The app tools this build's loop can run. Everything else is not declared. */
export const CLIENT_TOOLS = [
  "agent.plan",
  "agent.ask",
  "agent.load_pack",
  "view.focus",
] as const;

const PACKS = new Set(["canvas", "clip", "assets", "story"]);

/**
 * Runs one tool that needs the interface.
 *
 * These are not sent to the server: a plan is a list on screen, a question is
 * a card the reader answers, and a focus change is the room turning to
 * something. A tool this loop has no implementation for is refused rather than
 * reported as done.
 */
export async function runAppTool(
  name: string,
  input: Record<string, unknown>,
  loadPacks: (packs: string[]) => void,
  setPlan: (plan: PlanItem[]) => void,
): Promise<AppToolAnswer> {
  if (name === "agent.plan") {
    const items = Array.isArray(input.items) ? input.items : [];
    const plan: PlanItem[] = items
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null,
      )
      .map((item, index) => ({
        id:
          typeof item.id === "string" && item.id.trim() !== ""
            ? item.id
            : `p${index + 1}`,
        title: typeof item.title === "string" ? item.title : "",
        status:
          item.status === "doing" ||
          item.status === "done" ||
          item.status === "failed"
            ? item.status
            : "todo",
      }));
    setPlan(plan);
    return { summary: `Plan: ${plan.length} steps`, data: { items: plan } };
  }

  if (name === "agent.ask") {
    const question =
      typeof input.question === "string" ? input.question.trim() : "";
    if (!question) {
      throw new ApiError({
        code: "VALIDATION_FAILED",
        message: "agent.ask needs a question",
        status: 422,
      });
    }
    const options = Array.isArray(input.options)
      ? input.options.filter(
          (option): option is string => typeof option === "string",
        )
      : [];
    const answer = await requestQuestion({ question, options });
    if (answer === null) {
      throw new ApiError({
        code: "USER_CANCELLED",
        message: "The question was dismissed",
        status: 409,
      });
    }
    return { summary: `The user answered: ${answer}`, data: { answer } };
  }

  if (name === "agent.load_pack") {
    const asked = Array.isArray(input.packs)
      ? input.packs.filter((pack): pack is string => typeof pack === "string")
      : [];
    const unknown = asked.filter((pack) => !PACKS.has(pack));
    if (unknown.length > 0 || asked.length === 0) {
      throw new ApiError({
        code: "VALIDATION_FAILED",
        message:
          unknown.length > 0
            ? `unknown tool pack: ${unknown.join(", ")}`
            : "agent.load_pack needs at least one pack",
        status: 422,
      });
    }
    loadPacks(asked);
    return {
      summary: `Loaded ${asked.join(", ")}`,
      data: { loaded: asked, available: [...PACKS] },
    };
  }

  if (name === "view.focus") {
    return focus(input);
  }

  throw new ApiError({
    code: "APP_ONLY_UNAVAILABLE",
    message: `${name} is not implemented in this interface`,
    status: 410,
  });
}

function focus(input: Record<string, unknown>): AppToolAnswer {
  const room = typeof input.room === "string" ? input.room : null;
  const strings = (key: string): string[] =>
    Array.isArray(input[key])
      ? input[key].filter((id): id is string => typeof id === "string")
      : [];
  const text = (key: string): string | null =>
    typeof input[key] === "string" ? (input[key] as string) : null;

  const canvasId = text("canvasId");
  if (canvasId) useProjectStore.getState().switchCanvas(canvasId);
  if (room === "canvas") {
    const nodeIds = strings("nodeIds");
    useEditorStore.getState().setSelection({ nodeIds, edgeIds: [] });
  }
  if (room === "clip") {
    const timelineId = text("timelineId");
    if (timelineId) useClipStore.getState().setActiveTimeline(timelineId);
    const clipIds = strings("clipIds");
    if (clipIds.length > 0) {
      useClipStore.getState().select({ clipIds });
    }
    const playhead = input.playheadMs;
    if (typeof playhead === "number" && playhead >= 0) {
      useClipStore.getState().setPlayhead(playhead);
    }
  }
  if (room === "assets") {
    const assetId = text("assetId");
    if (assetId) useAssetsStore.getState().select(assetId);
  }
  if (room === "story") {
    const storyId = text("storyId");
    if (storyId) useStoryStore.getState().select(storyId);
    const step = text("step");
    if (
      step === "idea" ||
      step === "outline" ||
      step === "elements" ||
      step === "storyboard" ||
      step === "edit"
    ) {
      useStoryStore.getState().goStep(step as StoryStep);
    }
    const chapterId = text("chapterId");
    if (chapterId) useStoryStore.getState().openChapter(chapterId);
  }
  return { summary: `Focused ${room ?? "the project"}`, data: { room } };
}
