import type { ResourceEntry } from "../shared/domain";
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

/** The counts the dock reads its context line from, in the room's own terms. */
export interface ContextCounts {
  room: AgentRoom;
  nodes: number;
  clips: number;
  chapters: number;
  matching: number;
  canvases: number;
  timelines: number;
  stories: number;
  assets: number;
}

export interface ChatContextEvent {
  counts: ContextCounts;
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
  assetsAdded: ResourceEntry[];
  assetsUpdated: ResourceEntry[];
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

export interface AgentToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  changeSetId?: string;
  auditId?: string;
  task?: { kind: AgentTaskKind; id: string };
  assetsAdded?: string[];
  assetsUpdated?: string[];
  assetsRemoved?: string[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
  durationMs?: number;
}

export interface AgentToolCallRecord {
  id: string;
  name: string;
  kind: AgentKind;
  risk?: AgentRisk;
  input: Record<string, unknown>;
  status: "pending" | "running" | "ok" | "error" | "skipped";
  result?: AgentToolResult;
  startedAt?: string;
  finishedAt?: string;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "error";
  text: string;
  createdAt: string;
  turnId?: string;
  stepIndex?: number;
  toolCalls?: AgentToolCallRecord[];
  references?: { kind: string; id: string; title: string }[];
  scope?: AgentScope;
  failure?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    retryable?: boolean;
  };
}

export interface AgentSession {
  id: string;
  title: string;
  messages: AgentMessage[];
  createdAt: string;
  updatedAt: string;
  lastScope?: AgentScope;
  model?: string | null;
}

export interface AgentSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  bytes: number;
  lastScope?: AgentScope;
  model?: string | null;
  snippet?: string;
}

export interface AgentSessionList {
  sessions: AgentSessionSummary[];
  warnings?: string[];
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const problem = await readProblem(response);
    throw problem ?? ApiError.parse(response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const agentSessionsApi = {
  list(
    query: { q?: string; limit?: number; cursor?: string } = {},
    signal?: AbortSignal,
  ): Promise<AgentSessionList> {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.limit) params.set("limit", String(query.limit));
    if (query.cursor) params.set("cursor", query.cursor);
    return fetch(`/api/v1/agent/sessions?${params.toString()}`, {
      signal,
      headers: projectHeaders(),
    }).then((response) => readJson<AgentSessionList>(response));
  },

  create(
    input: { title?: string; model?: string | null; scope?: AgentScope },
    signal?: AbortSignal,
  ): Promise<{ session: AgentSessionSummary }> {
    return fetch("/api/v1/agent/sessions", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", ...projectHeaders() },
      body: JSON.stringify(input),
    }).then((response) => readJson<{ session: AgentSessionSummary }>(response));
  },

  get(
    id: string,
    query: { limit?: number; before?: string } = {},
    signal?: AbortSignal,
  ): Promise<{ session: AgentSession }> {
    const params = new URLSearchParams();
    if (query.limit) params.set("limit", String(query.limit));
    if (query.before) params.set("before", query.before);
    return fetch(
      `/api/v1/agent/sessions/${encodeURIComponent(id)}?${params.toString()}`,
      { signal, headers: projectHeaders() },
    ).then((response) => readJson<{ session: AgentSession }>(response));
  },

  patch(
    id: string,
    input: { title?: string; model?: string; scope?: AgentScope },
    signal?: AbortSignal,
  ): Promise<{ session: AgentSessionSummary }> {
    return fetch(`/api/v1/agent/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      signal,
      headers: { "Content-Type": "application/json", ...projectHeaders() },
      body: JSON.stringify(input),
    }).then((response) => readJson<{ session: AgentSessionSummary }>(response));
  },

  delete(id: string, signal?: AbortSignal): Promise<void> {
    return fetch(`/api/v1/agent/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal,
      headers: projectHeaders(),
    }).then((response) => readJson<void>(response));
  },

  deleteMany(
    ids: string[],
    signal?: AbortSignal,
  ): Promise<{ deleted: number; warnings: string[] }> {
    return fetch("/api/v1/agent/sessions/delete", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", ...projectHeaders() },
      body: JSON.stringify({ ids }),
    }).then((response) =>
      readJson<{ deleted: number; warnings: string[] }>(response),
    );
  },

  append(
    id: string,
    message: AgentMessage,
    signal?: AbortSignal,
  ): Promise<{ session: AgentSessionSummary; trimmed: number }> {
    return fetch(`/api/v1/agent/sessions/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", ...projectHeaders() },
      body: JSON.stringify(message),
    }).then((response) =>
      readJson<{ session: AgentSessionSummary; trimmed: number }>(response),
    );
  },

  updateMessage(
    id: string,
    message: AgentMessage,
    signal?: AbortSignal,
  ): Promise<{ session: AgentSessionSummary; trimmed: number }> {
    return fetch(
      `/api/v1/agent/sessions/${encodeURIComponent(id)}/messages/${encodeURIComponent(message.id)}`,
      {
        method: "PUT",
        signal,
        headers: { "Content-Type": "application/json", ...projectHeaders() },
        body: JSON.stringify(message),
      },
    ).then((response) =>
      readJson<{ session: AgentSessionSummary; trimmed: number }>(response),
    );
  },
};
