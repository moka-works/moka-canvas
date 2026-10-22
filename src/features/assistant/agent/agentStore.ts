import { create } from "zustand";
import {
  agentApi,
  agentSessionsApi,
  type AgentRoom,
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

/** Every room the dock is mounted in, and so every room with a conversation. */
export const AGENT_ROOMS: readonly AgentRoom[] = [
  "canvas",
  "clip",
  "assets",
  "story",
];

/**
 * What one room's dock is showing.
 *
 * A room keeps its own conversation rather than the four sharing one view:
 * a question asked in the cutting room belongs there, and trouble it ran
 * into must not follow the reader to the shelf.
 */
export interface RoomView {
  session: AgentSession | null;
  messages: DockMessage[];
  busy: boolean;
  draft: string;
  error: string | null;
  context: ContextCounts | null;
  warnings: string[];
  plan: PlanItem[] | null;
  packs: string[];
  model: string | null;
  historyOpen: boolean;
  approval: ApprovalView | null;
  question: QuestionView | null;
  abort: AbortController | null;
}

export function blankView(): RoomView {
  return {
    session: null,
    messages: [],
    busy: false,
    draft: "",
    error: null,
    context: null,
    warnings: [],
    plan: null,
    packs: [],
    model: null,
    historyOpen: false,
    approval: null,
    question: null,
    abort: null,
  };
}

function blankViews(): Record<AgentRoom, RoomView> {
  return AGENT_ROOMS.reduce(
    (views, room) => ({ ...views, [room]: blankView() }),
    {} as Record<AgentRoom, RoomView>,
  );
}

interface AgentState {
  /** The room whose dock is mounted; scene for anything not room-addressed. */
  room: AgentRoom;
  views: Record<AgentRoom, RoomView>;
  sessions: AgentSessionSummary[];
  sessionsLoading: boolean;
  sessionQuery: string;
  catalogHash: string | null;

  refreshSessions: (room: AgentRoom, query?: string) => Promise<void>;
  newSession: (room: AgentRoom) => Promise<void>;
  loadSession: (room: AgentRoom, id: string) => Promise<void>;
  deleteSession: (room: AgentRoom, id: string) => Promise<void>;
  renameSession: (room: AgentRoom, id: string, title: string) => Promise<void>;
  setHistoryOpen: (room: AgentRoom, open: boolean) => void;
  setSessionQuery: (room: AgentRoom, query: string) => void;
  setRoom: (room: AgentRoom) => void;
  setDraft: (room: AgentRoom, draft: string) => void;
  setModel: (room: AgentRoom, model: string | null) => void;
  send: (room: AgentRoom) => Promise<void>;
  stop: (room: AgentRoom) => void;
  approve: (room: AgentRoom) => void;
  deny: (room: AgentRoom) => void;
  answerQuestion: (room: AgentRoom, answer: string) => void;
  dismissQuestion: (room: AgentRoom) => void;

  addMessage: (room: AgentRoom, message: DockMessage) => void;
  updateMessage: (
    room: AgentRoom,
    id: string,
    patch: Partial<DockMessage>,
  ) => void;
  updateCall: (
    room: AgentRoom,
    messageId: string,
    callId: string,
    patch: Partial<AgentToolCallRecord>,
  ) => void;
  setBusy: (
    room: AgentRoom,
    busy: boolean,
    abort?: AbortController | null,
  ) => void;
  setError: (room: AgentRoom, error: string | null) => void;
  setContext: (room: AgentRoom, context: ContextCounts | null) => void;
  setWarnings: (room: AgentRoom, warnings: string[]) => void;
  setPlan: (room: AgentRoom, plan: PlanItem[] | null) => void;
  addPacks: (room: AgentRoom, packs: string[]) => void;
  setCatalogHash: (hash: string | null) => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useAgentStore = create<AgentState>()((set, get) => {
  const view = (room: AgentRoom): RoomView => get().views[room];

  const patch = (
    room: AgentRoom,
    changes: Partial<RoomView> | ((current: RoomView) => Partial<RoomView>),
  ): void => {
    set((state) => ({
      views: {
        ...state.views,
        [room]: {
          ...state.views[room],
          ...(typeof changes === "function"
            ? changes(state.views[room])
            : changes),
        },
      },
    }));
  };

  /** Applies one change to every view, for list-level edits. */
  const each = (changes: (view: RoomView) => Partial<RoomView>): void => {
    set((state) => ({
      views: AGENT_ROOMS.reduce(
        (views, room) => ({
          ...views,
          [room]: { ...state.views[room], ...changes(state.views[room]) },
        }),
        {} as Record<AgentRoom, RoomView>,
      ),
    }));
  };

  return {
    room: "canvas",
    views: blankViews(),
    sessions: [],
    sessionsLoading: false,
    sessionQuery: "",
    catalogHash: null,

    async refreshSessions(room, query) {
      set({ sessionsLoading: true });
      try {
        const answered = await agentSessionsApi.list({
          q: query ?? get().sessionQuery,
          limit: 40,
        });
        set({ sessions: answered.sessions, sessionsLoading: false });
      } catch (error) {
        set({ sessionsLoading: false });
        patch(room, { error: message(error) });
      }
    },

    async newSession(room) {
      if (view(room).busy) get().stop(room);
      if (view(room).messages.length === 0) return;
      patch(room, {
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

    async loadSession(room, id) {
      if (view(room).busy) get().stop(room);
      set({ sessionsLoading: true });
      patch(room, { error: null, historyOpen: false });
      try {
        const answered = await agentSessionsApi.get(id, { limit: 200 });
        set({ sessionsLoading: false });
        patch(room, {
          session: answered.session,
          messages: answered.session.messages,
          plan: null,
          model: answered.session.model ?? null,
        });
      } catch (error) {
        set({ sessionsLoading: false });
        patch(room, { error: message(error) });
      }
    },

    async deleteSession(room, id) {
      try {
        await agentSessionsApi.delete(id);
        set((state) => ({
          sessions: state.sessions.filter((session) => session.id !== id),
        }));
        each((current) =>
          current.session?.id === id
            ? { session: null, messages: [], plan: null }
            : {},
        );
      } catch (error) {
        patch(room, { error: message(error) });
      }
    },

    async renameSession(room, id, title) {
      try {
        const answered = await agentSessionsApi.patch(id, { title });
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === id ? answered.session : session,
          ),
        }));
        each((current) =>
          current.session?.id === id
            ? { session: { ...current.session, title: answered.session.title } }
            : {},
        );
      } catch (error) {
        patch(room, { error: message(error) });
      }
    },

    setHistoryOpen(room, open) {
      patch(room, { historyOpen: open });
      if (open) void get().refreshSessions(room);
    },

    setSessionQuery(room, query) {
      set({ sessionQuery: query });
      void get().refreshSessions(room, query);
    },

    setRoom(room) {
      if (get().room !== room) set({ room });
    },

    setDraft(room, draft) {
      patch(room, { draft });
    },

    setModel(room, model) {
      patch(room, { model });
      const session = view(room).session;
      if (!session) return;
      void agentSessionsApi
        .patch(session.id, { model: model ?? "" })
        .then((answered) => {
          set((state) => ({
            sessions: state.sessions.map((each) =>
              each.id === session.id ? answered.session : each,
            ),
          }));
          each((current) =>
            current.session?.id === session.id
              ? {
                  session: {
                    ...current.session,
                    model: answered.session.model ?? null,
                  },
                }
              : {},
          );
        })
        .catch((error: unknown) => patch(room, { error: message(error) }));
    },

    async send(room) {
      const text = view(room).draft.trim();
      if (text === "" || view(room).busy) return;
      patch(room, { draft: "", error: null, busy: true });
      try {
        const { runTurn } = await import("./loop");
        await runTurn(room, text);
      } catch (error) {
        patch(room, {
          error: message(error),
          busy: false,
          abort: null,
        });
      }
    },

    stop(room) {
      view(room).abort?.abort();
      // A loop stopped while a person was being asked is a loop whose promise
      // would otherwise never settle.
      settleApproval(room, false);
      settleQuestion(room, null);
      patch(room, {
        busy: false,
        abort: null,
        approval: null,
        question: null,
      });
    },

    approve(room) {
      settleApproval(room, true);
      patch(room, { approval: null });
    },

    deny(room) {
      settleApproval(room, false);
      patch(room, { approval: null });
    },

    answerQuestion(room, answer) {
      settleQuestion(room, answer);
      patch(room, { question: null });
    },

    dismissQuestion(room) {
      settleQuestion(room, null);
      patch(room, { question: null });
    },

    addMessage(room, added) {
      patch(room, (current) => ({ messages: [...current.messages, added] }));
    },

    updateMessage(room, id, changes) {
      patch(room, (current) => ({
        messages: current.messages.map((each) =>
          each.id === id ? { ...each, ...changes } : each,
        ),
        session: current.session
          ? {
              ...current.session,
              messages: current.session.messages.map((each) =>
                each.id === id ? { ...each, ...changes } : each,
              ),
            }
          : null,
      }));
    },

    updateCall(room, messageId, callId, changes) {
      const apply = (each: DockMessage): DockMessage => ({
        ...each,
        toolCalls: (each.toolCalls ?? []).map((call) =>
          call.id === callId ? { ...call, ...changes } : call,
        ),
      });
      patch(room, (current) => ({
        messages: current.messages.map((each) =>
          each.id === messageId ? apply(each) : each,
        ),
        session: current.session
          ? {
              ...current.session,
              messages: current.session.messages.map((each) =>
                each.id === messageId ? apply(each) : each,
              ),
            }
          : null,
      }));
    },

    setBusy(room, busy, abort) {
      patch(room, {
        busy,
        ...(abort === undefined ? {} : { abort }),
      });
    },

    setError(room, error) {
      patch(room, { error });
    },

    setContext(room, context) {
      patch(room, { context });
    },

    setWarnings(room, warnings) {
      patch(room, { warnings });
    },

    setPlan(room, plan) {
      patch(room, { plan });
    },

    addPacks(room, packs) {
      patch(room, (current) => ({
        packs: [...new Set([...current.packs, ...packs])],
      }));
    },

    setCatalogHash(catalogHash) {
      set({ catalogHash });
    },
  };
});

watchInteractions({
  approval: (room, approval) =>
    useAgentStore.setState((state) => ({
      views: {
        ...state.views,
        [room]: { ...state.views[room], approval },
      },
    })),
  question: (room, question) =>
    useAgentStore.setState((state) => ({
      views: {
        ...state.views,
        [room]: { ...state.views[room], question },
      },
    })),
});

/** Seeds each room's view from what is standing when the dock opens. */
useAgentStore.setState((state) => ({
  views: AGENT_ROOMS.reduce(
    (views, room) => ({
      ...views,
      [room]: {
        ...state.views[room],
        approval: currentApproval(room),
        question: currentQuestion(room),
      },
    }),
    {} as Record<AgentRoom, RoomView>,
  ),
}));

/**
 * The conversation a room's turn happens in, made on first use.
 *
 * A session is created with the reader's current room in `lastScope`, so the
 * list can say where the conversation came from without opening it.
 */
export async function ensureSession(
  room: AgentRoom,
  scope: AgentScope,
): Promise<AgentSession> {
  const existing = useAgentStore.getState().views[room].session;
  if (existing) return existing;
  const model = useAgentStore.getState().views[room].model;
  const created = await agentSessionsApi.create({
    scope,
    ...(model ? { model } : {}),
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
  useAgentStore.setState((state) => ({
    views: {
      ...state.views,
      [room]: { ...state.views[room], session },
    },
  }));
  void useAgentStore.getState().refreshSessions(room);
  return session;
}

/** Keeps the list's title, and any room showing that session, in step. */
export async function refreshSessionTitle(sessionId: string): Promise<void> {
  const answered = await agentSessionsApi.list({ limit: 40 });
  const summary = answered.sessions.find((each) => each.id === sessionId);
  if (!summary) return;
  useAgentStore.setState((state) => ({
    sessions: answered.sessions,
    views: AGENT_ROOMS.reduce(
      (views, room) => {
        const current = state.views[room];
        return {
          ...views,
          [room]:
            current.session?.id === sessionId
              ? {
                  ...current,
                  session: {
                    ...current.session,
                    title: summary.title,
                    updatedAt: summary.updatedAt,
                  },
                }
              : current,
        };
      },
      {} as Record<AgentRoom, RoomView>,
    ),
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
