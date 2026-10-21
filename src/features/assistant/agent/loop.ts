import {
  agentApi,
  agentSessionsApi,
  type AgentMessage,
  type AgentTaskKind,
  type AgentTaskStatus,
  type AgentToolCallRecord,
  type AgentToolResult,
  type ChatTurn,
  type ToolSpec,
} from "../../../api";
import { newId, nowIso } from "../../../shared/domain";
import type { DocumentCommand } from "../../../shared/domain";
import { i18n } from "../../../shared/i18n";
import { useProjectStore } from "../../editor/stores/projectStore";
import { askSavePath, fileSafeName } from "../../editor/launcher/savePath";
import { requestApproval } from "./interaction";
import { runAppTool, CLIENT_TOOLS } from "./appTools";
import { buildScope } from "./scope";
import {
  ensureSession,
  loadCatalog,
  refreshSessionTitle,
  useAgentStore,
} from "./agentStore";
import type { DockMessage } from "./types";

const MAX_STEPS = 12;
const TASK_WAIT_MS = 90_000;
const MAX_HISTORY_TURNS = 60;
const OBSERVATION_CHARS = 4_000;

function truncate(value: unknown, limit: number): unknown {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (text === undefined) return value;
  if (text.length <= limit) return value;
  return `${text.slice(0, limit)}…`;
}

function messageOf(
  role: AgentMessage["role"],
  text: string,
  turnId: string,
  extra: Partial<DockMessage> = {},
): DockMessage {
  return {
    id: newId(),
    role,
    text,
    createdAt: nowIso(),
    turnId,
    ...extra,
  };
}

/** The temporary transcript a chat step is given, newest last. */
function transcriptOf(messages: readonly DockMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    if (message.live) continue;
    if (message.role === "user") {
      turns.push({ role: "user", text: message.text });
      continue;
    }
    if (message.role !== "assistant") continue;
    const calls = message.toolCalls ?? [];
    if (calls.length === 0) {
      if (message.text.trim() !== "") {
        turns.push({ role: "assistant", text: message.text });
      }
      continue;
    }
    turns.push({
      role: "assistant",
      text: message.text,
      toolCalls: calls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.input,
      })),
    });
    for (const call of calls) {
      const result = call.result;
      turns.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        text: result
          ? JSON.stringify({
              ok: result.ok,
              summary: result.summary,
              data: truncate(result.data, OBSERVATION_CHARS),
              task: result.task,
              error: result.error,
            })
          : JSON.stringify({ ok: false, summary: "the tool did not finish" }),
      });
    }
  }
  return turns.slice(-MAX_HISTORY_TURNS);
}

async function persist(
  sessionId: string,
  message: DockMessage,
  existing: boolean,
): Promise<void> {
  if (existing) {
    await agentSessionsApi.updateMessage(sessionId, message);
  } else {
    await agentSessionsApi.append(sessionId, message);
  }
}

/**
 * One turn: the reader's words, then as many model steps and tool calls as it
 * takes to answer.
 *
 * The loop never invents a success: a tool result is the only evidence a
 * change happened, and an error is put back in front of the model as the
 * observation it has to work with.
 */
export async function runTurn(text: string): Promise<void> {
  const store = useAgentStore.getState();
  const room = store.room;
  const scope = buildScope(room);
  const turnId = newId();
  const session = await ensureSession(scope);

  const user = messageOf("user", text, turnId, { scope });
  store.addMessage(user);
  await agentSessionsApi.append(session.id, user);
  void refreshSessionTitle(session.id);

  // The server reads the file, so anything still on its way must land first.
  await useProjectStore.getState().flush();
  if (useProjectStore.getState().pending.length > 0) {
    throw new Error(i18n.t("agent:errors.saveFirst"));
  }

  const abort = new AbortController();
  store.setBusy(true, abort);
  store.setError(null);

  try {
    for (let stepIndex = 0; stepIndex < MAX_STEPS; stepIndex += 1) {
      if (abort.signal.aborted) throw new DOMException("stopped", "AbortError");
      const catalog = await loadCatalog(abort.signal);
      const live = messageOf("assistant", "", turnId, {
        stepIndex,
        live: true,
        toolCalls: [],
      });
      useAgentStore.getState().addMessage(live);

      let streamed = "";
      let done;
      try {
        done = await agentApi.chat(
          {
            model: store.model,
            scope,
            packs: ["core", ...new Set([room, ...store.packs])],
            clientTools: [...CLIENT_TOOLS],
            catalogHash: catalog.catalogHash,
            messages: transcriptOf(useAgentStore.getState().messages),
            locale: i18n.language,
          },
          {
            onContext: (context) => {
              const state = useAgentStore.getState();
              state.setContextLine(context.summary);
              state.setWarnings(context.warnings);
            },
            onText: (delta) => {
              streamed += delta;
              useAgentStore.getState().updateMessage(live.id, {
                text: streamed,
              });
            },
          },
          abort.signal,
        );
      } catch (error) {
        useAgentStore.getState().updateMessage(live.id, { live: false });
        throw error;
      }

      const calls: AgentToolCallRecord[] = done.toolCalls.map((call) => {
        const spec = catalog.tools.find((tool) => tool.name === call.name);
        return {
          id: call.id,
          name: call.name,
          kind: spec?.kind ?? "command",
          risk: spec?.risk,
          input: call.arguments,
          status: "pending" as const,
        };
      });
      const assistantText = done.text || streamed;
      useAgentStore.getState().updateMessage(live.id, {
        live: false,
        text: assistantText,
        toolCalls: calls,
      });
      const stepMessage: DockMessage = {
        ...live,
        live: false,
        text: assistantText,
        toolCalls: calls,
      };
      await persist(session.id, stepMessage, false);

      if (calls.length === 0) {
        if (assistantText.trim() === "") {
          throw new Error(i18n.t("agent:errors.emptyAnswer"));
        }
        return;
      }

      for (const call of calls) {
        if (abort.signal.aborted)
          throw new DOMException("stopped", "AbortError");
        const spec = catalog.tools.find((tool) => tool.name === call.name);
        useAgentStore.getState().updateCall(stepMessage.id, call.id, {
          status: "running",
          startedAt: nowIso(),
        });
        let result: AgentToolResult;
        const started = Date.now();
        try {
          if (!spec) {
            throw Object.assign(new Error(`unknown tool ${call.name}`), {
              code: "TOOL_NOT_FOUND",
            });
          }
          result =
            spec.surface === "app"
              ? await runApp(
                  spec,
                  call,
                  (packs) => useAgentStore.getState().addPacks(packs),
                  (plan) => useAgentStore.getState().setPlan(plan),
                )
              : await runServer(spec, call, session.id, turnId, abort.signal);
          if (result.task) {
            const task = await waitForTask(result.task, abort.signal);
            result.data = { ...(result.data as object), task };
            result.summary = `${result.summary} — ${task.status}`;
          }
        } catch (error) {
          const api = error as { code?: string; message?: string };
          result = {
            ok: false,
            summary: api.message ?? String(error),
            error: {
              code: api.code ?? "INTERNAL",
              message: api.message ?? String(error),
            },
          };
        }
        result.durationMs = Date.now() - started;
        useAgentStore.getState().updateCall(stepMessage.id, call.id, {
          status: result.ok ? "ok" : "error",
          result,
          finishedAt: nowIso(),
        });
        await persist(
          session.id,
          {
            ...useAgentStore
              .getState()
              .messages.find((each) => each.id === stepMessage.id)!,
          },
          true,
        );
      }
    }
    throw new Error(i18n.t("agent:errors.stepLimit", { count: MAX_STEPS }));
  } catch (error) {
    const stopped =
      (error as Error).name === "AbortError" ||
      (error as { code?: string }).code === "USER_CANCELLED";
    const failure = {
      code: stopped
        ? "USER_CANCELLED"
        : ((error as { code?: string }).code ?? "INTERNAL"),
      message: stopped
        ? i18n.t("agent:errors.stopped")
        : error instanceof Error
          ? error.message
          : String(error),
      retryable: !stopped,
    };
    const message = messageOf("error", failure.message, turnId, { failure });
    useAgentStore.getState().addMessage(message);
    try {
      await agentSessionsApi.append(session.id, message);
    } catch {
      // The conversation is already on screen; failing to write the failure
      // down is not a second failure worth hiding the first behind.
    }
    if (!stopped) useAgentStore.getState().setError(failure.message);
  } finally {
    useAgentStore.getState().setBusy(false, null);
  }
}

async function runApp(
  spec: ToolSpec,
  call: AgentToolCallRecord,
  loadPacks: (packs: string[]) => void,
  setPlan: (plan: import("./types").PlanItem[]) => void,
): Promise<AgentToolResult> {
  const answer = await runAppTool(spec.name, call.input, loadPacks, setPlan);
  return { ok: true, summary: answer.summary, data: answer.data };
}

async function destinationFor(
  spec: ToolSpec,
  input: Record<string, unknown>,
): Promise<string> {
  if (
    typeof input.destination === "string" &&
    input.destination.trim() !== ""
  ) {
    return input.destination;
  }
  const project = useProjectStore.getState().moka;
  let name = "export";
  let extensions: string[] = [];
  if (spec.name === "project.export") {
    name = `${fileSafeName(project?.metadata.name ?? "project")}.mokapkg.zip`;
    extensions = ["zip"];
  } else if (spec.name === "timeline.export") {
    const timelineId = input.timelineId;
    const timeline = project?.timelines?.find((each) => each.id === timelineId);
    name = fileSafeName(timeline?.name ?? "export");
    extensions = ["mp4"];
  } else if (spec.name === "clip.export_srt") {
    name = "subtitles";
    extensions = ["srt"];
  } else if (spec.name === "asset.copy") {
    const assetId = input.assetId;
    const entries = Object.values(project?.resources ?? {}).flat();
    name = fileSafeName(
      entries.find((entry) => entry.id === assetId)?.name ?? "asset",
    );
  }
  const chosen = await askSavePath({
    title: i18n.t("agent:destination.title", { tool: spec.title }),
    defaultName: extensions[0] ? `${name}.${extensions[0]}` : name,
    extensions,
  });
  if (chosen === null) {
    throw Object.assign(
      new Error(i18n.t("agent:errors.destinationCancelled")),
      {
        code: "USER_CANCELLED",
      },
    );
  }
  return chosen;
}

async function runServer(
  spec: ToolSpec,
  call: AgentToolCallRecord,
  sessionId: string,
  turnId: string,
  signal: AbortSignal,
): Promise<AgentToolResult> {
  const input: Record<string, unknown> = { ...call.input };
  if (
    spec.risk === "spend" ||
    spec.risk === "destroy" ||
    spec.risk === "export"
  ) {
    const approved = await requestApproval({
      tool: spec.name,
      title: spec.title,
      description: spec.description,
      risk: spec.risk,
      input,
    });
    if (!approved) {
      throw Object.assign(new Error(i18n.t("agent:errors.denied")), {
        code: "APPROVAL_DENIED",
      });
    }
  }
  if (spec.requiresDestination) {
    input.destination = await destinationFor(spec, input);
  }
  if (spec.risk === "destroy" && typeof input.confirm !== "string") {
    input.confirm = "approved";
  }

  const project = useProjectStore.getState();
  const isCommand = spec.kind === "command";
  const release = isCommand ? await project.holdWrites() : null;
  try {
    const response = await agentApi.callTool(
      spec.name,
      {
        input,
        actor: "ui",
        sessionId,
        turnId,
        idempotencyKey: call.id,
        acknowledgeRisk: true,
      },
      signal,
    );
    if (
      spec.kind === "command" &&
      response.changeSetId &&
      response.commands.length > 0
    ) {
      useProjectStore
        .getState()
        .adoptAgentCommands(
          response.commands as DocumentCommand[],
          response.revision,
          response.updatedAt,
          response.changeSetId,
          spec.title,
        );
    }
    for (const entry of response.assetsAdded) {
      useProjectStore.getState().integrateAssetEntry(entry, {
        revision: response.revision,
        updatedAt: response.updatedAt,
      });
    }
    for (const entry of response.assetsUpdated) {
      useProjectStore.getState().integrateAssetEntry(entry, {
        revision: response.revision,
        updatedAt: response.updatedAt,
      });
    }
    for (const assetId of response.assetsRemoved) {
      useProjectStore.getState().removeAssetEntry(assetId, {
        revision: response.revision,
        updatedAt: response.updatedAt,
      });
    }
    useProjectStore
      .getState()
      .setRevision(response.revision, response.updatedAt);
    return {
      ok: response.ok,
      summary: response.summary,
      data: response.data,
      changeSetId: response.changeSetId ?? undefined,
      auditId: response.auditId ?? undefined,
      task: response.task ?? undefined,
      assetsAdded: response.assetsAdded.map((entry) => entry.id),
      assetsUpdated: response.assetsUpdated.map((entry) => entry.id),
      assetsRemoved: response.assetsRemoved,
    };
  } finally {
    if (release) release();
  }
}

async function waitForTask(
  task: { kind: AgentTaskKind; id: string },
  signal: AbortSignal,
): Promise<AgentTaskStatus> {
  const deadline = Date.now() + TASK_WAIT_MS;
  let delay = 1_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new DOMException("stopped", "AbortError");
    const status = await agentApi.task(task.kind, task.id, signal);
    if (
      status.status === "succeeded" ||
      status.status === "failed" ||
      status.status === "cancelled"
    ) {
      if (task.kind === "run" && status.status === "succeeded") {
        await useProjectStore.getState().reload();
      }
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(5_000, delay + 1_000);
  }
  return { status: "pending", message: i18n.t("agent:tasks.stillRunning") };
}
