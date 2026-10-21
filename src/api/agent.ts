import {
  ApiError,
  currentProject,
  projectHeaders,
  readProblem,
} from "./client";

export type AgentRoom = "canvas" | "clip" | "assets" | "story";
export type AgentKind = "command" | "effect";
export type AgentSurface = "both" | "app" | "external";
export type AgentRisk = "read" | "write" | "spend" | "destroy" | "export";
export type AgentTaskKind = "run" | "storyJob" | "asr" | "clipExport";

export interface AgentScope {
  room: AgentRoom;
  canvasId?: string;
  nodeIds?: string[];
  timelineId?: string;
  clipIds?: string[];
  playheadMs?: number;
  assetId?: string;
  assetFilter?: {
    kind?: string;
    query?: string;
    tags?: string[];
    unused?: boolean;
  };
  storyId?: string;
  step?: string;
  chapterId?: string;
  actId?: string;
  keyframeId?: string;
  elementId?: string;
}

export interface ToolSpec {
  name: string;
  version: number;
  kind: AgentKind;
  pack: string;
  surface: AgentSurface;
  title: string;
  description: string;
  risk: AgentRisk;
  risks: AgentRisk[];
  mutates: boolean;
  idempotent: boolean;
  supportsDryRun: boolean;
  longRunning: boolean;
  requiresDestination: boolean;
  input: Record<string, unknown>;
  dataSchema?: Record<string, unknown>;
  errorCodes: string[];
  examples?: unknown[];
}

export interface ToolCatalog {
  catalogVersion: string;
  catalogHash: string;
  packs: { name: string; title: string }[];
  tools: ToolSpec[];
}

export interface AgentCapabilities {
  catalogVersion: string;
  catalogHash: string;
  packs: { name: string; title: string }[];
  surfaces: AgentSurface[];
  toolCount: number;
}

export interface ChatTurnCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatTurn {
  role: "user" | "assistant" | "tool";
  text: string;
  toolCalls?: ChatTurnCall[];
  toolCallId?: string;
  name?: string;
}

export interface ChatRequest {
  model?: string | null;
  scope: AgentScope;
  packs: string[];
  clientTools: string[];
  catalogHash: string;
  messages: ChatTurn[];
  locale?: string;
  protocol?: "auto" | "native" | "json";
}

export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  images?: number;
  seconds?: number;
}

export interface ChatDone {
  text: string;
  toolCalls: ChatTurnCall[];
  usage?: ChatUsage;
  protocol: "native" | "json";
  stopReason?: string | null;
  toolsetHash: string;
  catalogHash: string;
}

export interface ChatContextEvent {
  summary: string;
  revision: number;
  warnings: string[];
}

export interface ChatHandlers {
  onContext?: (context: ChatContextEvent) => void;
  onText?: (delta: string) => void;
  onToolCall?: (call: ChatTurnCall) => void;
}

export interface ToolCallRequest {
  input: Record<string, unknown>;
  dryRun?: boolean;
  acknowledgeRisk?: boolean;
  idempotencyKey?: string;
  requestId?: string;
  actor?: "ui" | "cli" | "mcp" | "http";
  sessionId?: string;
  turnId?: string;
}

export interface ToolCallResponse {
  ok: boolean;
  tool: string;
  version: number;
  kind: AgentKind;
  summary: string;
  data?: unknown;
  commands: unknown[];
  assetsAdded: string[];
  assetsUpdated: string[];
  assetsRemoved: string[];
  baseRevision: number;
  revision: number;
  updatedAt: string;
  changeSetId?: string | null;
  auditId?: string | null;
  task?: { kind: AgentTaskKind; id: string } | null;
  warnings: string[];
  view?: unknown;
  reload: boolean;
  trimmed?: number;
}

export interface AgentTaskStatus {
  status:
    "queued" | "running" | "succeeded" | "failed" | "cancelled" | "pending";
  progress?: number;
  message?: string;
  result?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
}

/** The problem code a stream event named, in the same shape as a response. */
function streamError(data: unknown, status = 0): ApiError {
  const body = data as {
    code?: string;
    message?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
  return new ApiError({
    code: body.code ?? "INTERNAL",
    message: body.message ?? "The agent step failed",
    status,
    details: {
      ...(body.details ?? {}),
      ...(body.retryable === undefined ? {} : { retryable: body.retryable }),
    },
  });
}

/**
 * Reads one SSE response, frame by frame.
 *
 * A frame is an `event:` line and a `data:` line; providers proxy these
 * streams, so comments and unknown events are dropped rather than treated as
 * answers. The promise settles on `done` or `error`, and rejects if the
 * connection ends before either.
 */
async function readChatStream(
  response: Response,
  handlers: ChatHandlers,
): Promise<ChatDone> {
  if (!response.ok) {
    const problem = await readProblem(response);
    throw problem ?? ApiError.parse(response.status);
  }
  if (!response.body) {
    throw ApiError.transport("The agent stream has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let settled: ChatDone | null = null;
  let failure: ApiError | null = null;

  const consume = (frame: string): void => {
    let event = "message";
    const data: string[] = [];
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data.join("\n"));
    } catch {
      return;
    }
    switch (event) {
      case "context":
        handlers.onContext?.(payload as ChatContextEvent);
        break;
      case "text":
        handlers.onText?.((payload as { delta: string }).delta);
        break;
      case "tool_call":
        handlers.onToolCall?.(payload as ChatTurnCall);
        break;
      case "done":
        settled = payload as ChatDone;
        break;
      case "error":
        failure = streamError(payload, 502);
        break;
      default:
        break;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      consume(frame);
      if (failure) {
        await reader.cancel().catch(() => {});
        throw failure;
      }
      if (settled) {
        await reader.cancel().catch(() => {});
        return settled;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== "") consume(buffer);
  if (failure) throw failure;
  if (settled) return settled;
  throw ApiError.transport("The agent stream ended before the step finished");
}

export const agentApi = {
  catalog(signal?: AbortSignal): Promise<ToolCatalog> {
    return fetch("/api/v1/agent/tools", {
      signal,
      headers: projectHeaders(),
    }).then(async (response) => {
      if (!response.ok) {
        const problem = await readProblem(response);
        throw problem ?? ApiError.parse(response.status);
      }
      return (await response.json()) as ToolCatalog;
    });
  },

  capabilities(signal?: AbortSignal): Promise<AgentCapabilities> {
    return fetch("/api/v1/agent/capabilities", {
      signal,
      headers: projectHeaders(),
    }).then(async (response) => {
      if (!response.ok) {
        const problem = await readProblem(response);
        throw problem ?? ApiError.parse(response.status);
      }
      return (await response.json()) as AgentCapabilities;
    });
  },

  context(scope: AgentScope, signal?: AbortSignal): Promise<unknown> {
    const query = new URLSearchParams({ room: scope.room });
    if (scope.canvasId) query.set("canvasId", scope.canvasId);
    if (scope.timelineId) query.set("timelineId", scope.timelineId);
    if (scope.assetId) query.set("assetId", scope.assetId);
    if (scope.storyId) query.set("storyId", scope.storyId);
    return fetch(`/api/v1/agent/context?${query.toString()}`, {
      signal,
      headers: projectHeaders(),
    }).then(async (response) => {
      if (!response.ok) {
        const problem = await readProblem(response);
        throw problem ?? ApiError.parse(response.status);
      }
      return response.json();
    });
  },

  chat(
    request: ChatRequest,
    handlers: ChatHandlers,
    signal?: AbortSignal,
  ): Promise<ChatDone> {
    const started = fetch("/api/v1/agent/chat", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...projectHeaders(),
      },
      body: JSON.stringify(request),
    });
    return started.then((response) => readChatStream(response, handlers));
  },

  callTool(
    name: string,
    request: ToolCallRequest,
    signal?: AbortSignal,
  ): Promise<ToolCallResponse> {
    return fetch(`/api/v1/agent/tools/${encodeURIComponent(name)}`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...projectHeaders(),
      },
      body: JSON.stringify({ actor: "ui", ...request }),
    }).then(async (response) => {
      if (!response.ok) {
        const problem = await readProblem(response);
        throw problem ?? ApiError.parse(response.status);
      }
      return (await response.json()) as ToolCallResponse;
    });
  },

  task(
    kind: AgentTaskKind,
    id: string,
    signal?: AbortSignal,
  ): Promise<AgentTaskStatus> {
    return this.callTool("task.get", { input: { kind, id } }, signal).then(
      (answer) => answer.data as AgentTaskStatus,
    );
  },

  /** The project this window's agent calls are about, for diagnostics. */
  project(): string | null {
    return currentProject();
  },
};

export { readChatStream };
