import type {
  AgentMessage,
  AgentRisk,
  AgentScope,
  AgentToolCallRecord,
  ToolSpec,
} from "../../../api";

/** A checklist the model keeps for work that takes several steps. */
export interface PlanItem {
  id: string;
  title: string;
  status: "todo" | "doing" | "done" | "failed";
}

/** The approval the loop is waiting on, as the dock draws it. */
export interface ApprovalView {
  tool: string;
  title: string;
  description: string;
  risk: AgentRisk;
  input: Record<string, unknown>;
}

/** The one question the model stopped to ask. */
export interface QuestionView {
  question: string;
  options: string[];
}

/** A line in the dock: a kept message, or one still arriving. */
export type DockMessage = AgentMessage & { live?: boolean };

export interface PendingStep {
  message: DockMessage;
  calls: AgentToolCallRecord[];
}

export interface TurnContext {
  room: AgentScope["room"];
  sessionId: string;
}

export interface AppToolAnswer {
  summary: string;
  data?: unknown;
}

export interface ToolSpecLookup {
  name: string;
  spec: ToolSpec;
}
