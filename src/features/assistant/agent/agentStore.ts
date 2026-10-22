import { create } from "zustand";
import {
  agentApi,
  agentSessionsApi,
  type AgentScope,
  type AgentSession,
  type AgentSessionSummary,
  type AgentToolCallRecord,
  type ContextCounts,
} from "../../../api";
import type {
  PlanItem,
  ApprovalView,
  DockMessage,
  QuestionView,
} from "./types";
import {
  currentApproval,
  currentQuestion,
  settleApproval,
  settleQuestion,
  watchInteractions,
} from "./interaction";

interface AgentState {
  room: import("../../../api").AgentRoom;
  sessions: AgentSessionSummary[];
  session: AgentSession | null;
  messages: DockMessage[];
  sessionsLoading: boolean;
  sessionQuery: string;
  historyOpen: boolean;
  busy: boolean;
  draft: string;
  error: string | null;
  context: ContextCounts | null;
  warnings: string[];
  plan: PlanItem[] | null;
  packs: string[];
  model: string | null;
  catalogHash: string | null;
  approval: ApprovalView | null;
  question: QuestionView | null;
  abort: AbortController | null;

  refreshSessions: (query?: string) => Promise<void>;
  newSession: () => Promise<void>;
  loadSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  setHistoryOpen: (open: boolean) => void;
  setSessionQuery: (query: string) => void;
  setRoom: (room: import("../../../api").AgentRoom) => void;
  setDraft: (draft: string) => void;
  setModel: (model: string | null) => void;
  send: () => Promise<void>;
  stop: () => void;
  approve: () => void;
  deny: () => void;
  answerQuestion: (answer: string) => void;
  dismissQuestion: () => void;

  setMessages: (messages: DockMessage[]) => void;
  addMessage: (message: DockMessage) => void;
  updateMessage: (id: string, patch: Partial<DockMessage>) => void;
  updateCall: (
    messageId: string,
    callId: string,
    patch: Partial<AgentToolCallRecord>,
  ) => void;
  setBusy: (busy: boolean, abort?: AbortController | null) => void;
  setError: (error: string | null) => void;
  setContext: (context: ContextCounts | null) => void;
  setWarnings: (warnings: string[]) => void;
  setPlan: (plan: PlanItem[] | null) => void;
  addPacks: (packs: string[]) => void;
  setCatalogHash: (hash: string | null) => void;
}

export const useAgentStore = create<AgentState>()((set, get) => ({
  room: "canvas",
  sessions: [],
  session: null,
  messages: [],
  sessionsLoading: false,
  sessionQuery: "",
  historyOpen: false,
  busy: false,
  draft: "",
  error: null,
  context: null,
  warnings: [],
  plan: null,
  packs: [],
  model: null,
  catalogHash: null,
  approval: null,
  question: null,
  abort: null,

  async refreshSessions(query) {
    set({ sessionsLoading: true });
    try {
      const answered = await agentSessionsApi.list({
        q: query ?? get().sessionQuery,
        limit: 40,
      });
      set({ sessions: answered.sessions, sessionsLoading: false });
    } catch (error) {
      set({
        sessionsLoading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async newSession() {
    if (get().busy) get().stop();
    if (get().messages.length === 0) return;
    set({
      session: null,
      messages: [],
      plan: null,
      error: null,
      context: null,
      warnings: [],
      historyOpen: false,
      packs: [],
    });
  },

  async loadSession(id) {
    if (get().busy) get().stop();
    set({ sessionsLoading: true, error: null, historyOpen: false });
    try {
      const answered = await agentSessionsApi.get(id, { limit: 200 });
      set({
        session: answered.session,
        messages: answered.session.messages,
        sessionsLoading: false,
        plan: null,
        model: answered.session.model ?? null,
      });
    } catch (error) {
      set({
        sessionsLoading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async deleteSession(id) {
    try {
      await agentSessionsApi.delete(id);
      const current = get().session;
      set((state) => ({
        sessions: state.sessions.filter((session) => session.id !== id),
        session: current?.id === id ? null : current,
        messages: current?.id === id ? [] : state.messages,
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async renameSession(id, title) {
    try {
      const answered = await agentSessionsApi.patch(id, { title });
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === id ? answered.session : session,
        ),
        session:
          state.session?.id === id
            ? { ...state.session, title: answered.session.title }
            : state.session,
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  setHistoryOpen(open) {
    set({ historyOpen: open });
    if (open) void get().refreshSessions();
  },

  setSessionQuery(query) {
    set({ sessionQuery: query });
    void get().refreshSessions(query);
  },

  setRoom(room) {
    if (get().room !== room) set({ room });
  },

  setDraft(draft) {
    set({ draft });
  },

  setModel(model) {
    set({ model });
    const session = get().session;
    if (!session) return;
    void agentSessionsApi
      .patch(session.id, { model: model ?? "" })
      .then((answered) => {
        set((state) => ({
          sessions: state.sessions.map((each) =>
            each.id === session.id ? answered.session : each,
          ),
          session:
            state.session?.id === session.id
              ? { ...state.session, model: answered.session.model ?? null }
              : state.session,
        }));
      })
      .catch((error: unknown) => {
        set({ error: error instanceof Error ? error.message : String(error) });
      });
  },

  async send() {
    const text = get().draft.trim();
    if (text === "" || get().busy) return;
    set({ draft: "", error: null, busy: true });
    try {
      const { runTurn } = await import("./loop");
      await runTurn(text);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        busy: false,
        abort: null,
      });
    }
  },

  stop() {
    get().abort?.abort();
    // A loop stopped while a person was being asked is a loop whose promise
    // would otherwise never settle.
    settleApproval(false);
    settleQuestion(null);
    set({
      busy: false,
      abort: null,
      approval: null,
      question: null,
    });
  },

  approve() {
    settleApproval(true);
    set({ approval: null });
  },

  deny() {
    settleApproval(false);
    set({ approval: null });
  },

  answerQuestion(answer) {
    settleQuestion(answer);
    set({ question: null });
  },

  dismissQuestion() {
    settleQuestion(null);
    set({ question: null });
  },

  setMessages(messages) {
    set({ messages });
  },

  addMessage(message) {
    set((state) => ({ messages: [...state.messages, message] }));
  },

  updateMessage(id, patch) {
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === id ? { ...message, ...patch } : message,
      ),
      session: state.session
        ? {
            ...state.session,
            messages: state.session.messages.map((message) =>
              message.id === id ? { ...message, ...patch } : message,
            ),
          }
        : null,
    }));
  },

  updateCall(messageId, callId, patch) {
    set((state) => {
      const apply = (message: DockMessage): DockMessage => ({
        ...message,
        toolCalls: (message.toolCalls ?? []).map((call) =>
          call.id === callId ? { ...call, ...patch } : call,
        ),
      });
      return {
        messages: state.messages.map((message) =>
          message.id === messageId ? apply(message) : message,
        ),
        session: state.session
          ? {
              ...state.session,
              messages: state.session.messages.map((message) =>
                message.id === messageId ? apply(message) : message,
              ),
            }
          : null,
      };
    });
  },

  setBusy(busy, abort) {
    set({ busy, ...(abort === undefined ? {} : { abort }) });
  },

  setError(error) {
    set({ error });
  },

  setContext(context) {
    set({ context });
  },

  setWarnings(warnings) {
    set({ warnings });
  },

  setPlan(plan) {
    set({ plan });
  },

  addPacks(packs) {
    set((state) => ({
      packs: [...new Set([...state.packs, ...packs])],
    }));
  },

  setCatalogHash(catalogHash) {
    set({ catalogHash });
  },
}));

watchInteractions({
  approval: (approval) => useAgentStore.setState({ approval }),
  question: (question) => useAgentStore.setState({ question }),
});

/** Seeds the store from what is standing when the dock opens. */
useAgentStore.setState({
  approval: currentApproval(),
  question: currentQuestion(),
});

/**
 * The conversation a turn happens in, made on first use.
 *
 * A session is created with the reader's current room in `lastScope`, so the
 * list can say where the conversation came from without opening it.
 */
export async function ensureSession(scope: AgentScope): Promise<AgentSession> {
  const existing = useAgentStore.getState().session;
  if (existing) return existing;
  const created = await agentSessionsApi.create({
    scope,
    ...(useAgentStore.getState().model
      ? { model: useAgentStore.getState().model }
      : {}),
  });
  const summary = created.session;
  const session: AgentSession = {
    id: summary.id,
    title: summary.title,
    messages: [],
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    lastScope: summary.lastScope ?? scope,
    model: summary.model ?? null,
  };
  useAgentStore.setState({ session });
  void useAgentStore.getState().refreshSessions();
  return session;
}

/** Keeps the list's title in step with the server's auto-title. */
export async function refreshSessionTitle(sessionId: string): Promise<void> {
  const answered = await agentSessionsApi.list({ limit: 40 });
  const summary = answered.sessions.find((each) => each.id === sessionId);
  if (!summary) return;
  useAgentStore.setState((state) => ({
    sessions: answered.sessions,
    session:
      state.session?.id === sessionId
        ? {
            ...state.session,
            title: summary.title,
            updatedAt: summary.updatedAt,
          }
        : state.session,
  }));
}

/** The catalog is one per process; fetched on first use and reused. */
let catalogCache: Awaited<ReturnType<typeof agentApi.catalog>> | null = null;

export async function loadCatalog(
  signal?: AbortSignal,
): Promise<NonNullable<typeof catalogCache>> {
  if (catalogCache) return catalogCache;
  const loaded = await agentApi.catalog(signal);
  catalogCache = loaded;
  useAgentStore.getState().setCatalogHash(loaded.catalogHash);
  return loaded;
}

export function invalidateCatalog(): void {
  catalogCache = null;
  useAgentStore.getState().setCatalogHash(null);
}
