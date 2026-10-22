import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentRoom, AgentToolCallRecord } from "../../../api";
import {
  effectiveDefaultId,
  modelOptionsFor,
  useModelStore,
} from "../../settings/modelStore";
import { useAgentStore, loadCatalog } from "./agentStore";
import type { DockMessage } from "./types";

const RISK_KEYS = {
  spend: "agent:approval.risk.spend",
  destroy: "agent:approval.risk.destroy",
  export: "agent:approval.risk.export",
} as const;

function statusKey(status: AgentToolCallRecord["status"]): string {
  return `agent:tool.${status}`;
}

function ToolCard({ call }: { call: AgentToolCallRecord }) {
  const { t } = useTranslation();
  const result = call.result;
  return (
    <li className={`agent-tool is-${call.status}`}>
      <div className="agent-tool-head">
        <span className="agent-tool-name">{call.name}</span>
        <span className="agent-tool-status">{t(statusKey(call.status))}</span>
      </div>
      {result && <p className="agent-tool-summary">{result.summary}</p>}
      {result?.error && (
        <p className="agent-tool-error">
          {result.error.code}: {result.error.message}
        </p>
      )}
      <div className="agent-tool-notes">
        {result?.changeSetId && (
          <span className="agent-tool-note">{t("agent:tool.undoable")}</span>
        )}
        {result?.auditId && (
          <span className="agent-tool-note is-strong">
            {t("agent:tool.audit")}
          </span>
        )}
        {result?.task && (
          <span className="agent-tool-note">
            {t("agent:tool.task")} · {result.task.kind}
          </span>
        )}
      </div>
      {(call.input || result?.data) && (
        <details className="agent-tool-details">
          <summary>{t("agent:tool.details")}</summary>
          <pre>{JSON.stringify(result?.data ?? call.input, null, 2)}</pre>
        </details>
      )}
    </li>
  );
}

function Line({ message }: { message: DockMessage }) {
  const { t } = useTranslation();
  return (
    <li className={`agent-line is-${message.role}`} data-testid="agent-line">
      <p className="agent-line-who">
        {t(
          message.role === "user"
            ? "agent:roles.user"
            : message.role === "error"
              ? "agent:roles.error"
              : "agent:roles.assistant",
        )}
      </p>
      {message.text && <p className="agent-line-words">{message.text}</p>}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <ul className="agent-tools">
          {message.toolCalls.map((call) => (
            <ToolCard call={call} key={call.id} />
          ))}
        </ul>
      )}
      {message.live && message.text === "" && (
        <p className="agent-line-thinking">{t("agent:status.thinking")}</p>
      )}
    </li>
  );
}

function SessionsPanel() {
  const { t } = useTranslation();
  const sessions = useAgentStore((state) => state.sessions);
  const query = useAgentStore((state) => state.sessionQuery);
  const loading = useAgentStore((state) => state.sessionsLoading);
  const session = useAgentStore((state) => state.session);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  return (
    <div className="agent-sessions" data-testid="agent-sessions">
      <input
        aria-label={t("agent:sessions.search")}
        className="agent-search"
        onChange={(event) =>
          useAgentStore.getState().setSessionQuery(event.target.value)
        }
        placeholder={t("agent:sessions.search")}
        value={query}
      />
      {loading && <p className="agent-muted">{t("agent:status.thinking")}</p>}
      {sessions.length === 0 && !loading ? (
        <p className="agent-muted">
          {query ? t("agent:sessions.noMatch") : t("agent:sessions.empty")}
        </p>
      ) : (
        <ul className="agent-session-list">
          {sessions.map((each) => (
            <li
              className={session?.id === each.id ? "is-current" : ""}
              key={each.id}
            >
              {renaming === each.id ? (
                <form
                  className="agent-session-rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void useAgentStore
                      .getState()
                      .renameSession(each.id, draft)
                      .then(() => setRenaming(null));
                  }}
                >
                  <input
                    autoFocus
                    onChange={(event) => setDraft(event.target.value)}
                    value={draft}
                  />
                  <button type="submit">{t("agent:question.answer")}</button>
                  <button onClick={() => setRenaming(null)} type="button">
                    {t("agent:sessions.cancel")}
                  </button>
                </form>
              ) : (
                <>
                  <button
                    className="agent-session-open"
                    onClick={() => {
                      void useAgentStore.getState().loadSession(each.id);
                    }}
                    type="button"
                  >
                    <span className="agent-session-title">
                      {each.title || t("agent:sessions.untitled")}
                    </span>
                    <span className="agent-session-meta">
                      {query && each.snippet
                        ? each.snippet
                        : t("agent:sessions.messages", {
                            count: each.messageCount,
                          })}
                    </span>
                  </button>
                  <div className="agent-session-actions">
                    <button
                      onClick={() => {
                        setRenaming(each.id);
                        setDraft(each.title);
                      }}
                      type="button"
                    >
                      {t("agent:sessions.rename")}
                    </button>
                    {deleting === each.id ? (
                      <>
                        <button
                          className="is-danger"
                          onClick={() => {
                            setDeleting(null);
                            void useAgentStore
                              .getState()
                              .deleteSession(each.id);
                          }}
                          type="button"
                        >
                          {t("agent:sessions.confirmDelete")}
                        </button>
                        <button onClick={() => setDeleting(null)} type="button">
                          {t("agent:sessions.cancel")}
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setDeleting(each.id)}
                        type="button"
                      >
                        {t("agent:sessions.delete")}
                      </button>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The assistant, wherever it is mounted.
 *
 * One dock for four rooms: the room prop decides the scope sent with a turn
 * and the tools on offer, while the conversation itself is project-level and
 * follows the reader from one room to another.
 */
export function AgentDock({
  room,
  compact = false,
}: {
  room: AgentRoom;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const messages = useAgentStore((state) => state.messages);
  const busy = useAgentStore((state) => state.busy);
  const draft = useAgentStore((state) => state.draft);
  const error = useAgentStore((state) => state.error);
  const contextLine = useAgentStore((state) => state.contextLine);
  const warnings = useAgentStore((state) => state.warnings);
  const plan = useAgentStore((state) => state.plan);
  const approval = useAgentStore((state) => state.approval);
  const question = useAgentStore((state) => state.question);
  const historyOpen = useAgentStore((state) => state.historyOpen);
  const model = useAgentStore((state) => state.model);
  const modelsView = useModelStore((state) => state.view);
  const models = modelOptionsFor(modelsView, "text");
  const defaultModel = models.find(
    (option) => option.reference === effectiveDefaultId(modelsView, "text"),
  );
  const [other, setOther] = useState("");
  const end = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    useAgentStore.getState().setRoom(room);
  }, [room]);

  useEffect(() => {
    void useAgentStore.getState().refreshSessions();
    void loadCatalog().catch(() => {
      useAgentStore.getState().setError(t("agent:errors.loadCatalog"));
    });
  }, [t]);

  useEffect(() => {
    if (useModelStore.getState().view === null) {
      void useModelStore.getState().load();
    }
  }, [room]);

  useEffect(() => {
    if (typeof end.current?.scrollIntoView === "function") {
      end.current.scrollIntoView({ block: "end" });
    }
  }, [messages, busy, approval, question]);

  const send = () => {
    if (draft.trim() === "" || busy) return;
    void useAgentStore.getState().send();
  };

  return (
    <section
      aria-label={t("agent:title")}
      className={`agent-dock${compact ? " is-compact" : ""}`}
      data-testid="agent-dock"
      data-room={room}
    >
      <header className="agent-head">
        <div className="agent-head-words">
          <h3>{t("agent:title")}</h3>
          <p className="agent-context">{contextLine ?? t("agent:emptyHint")}</p>
        </div>
        <div className="agent-head-actions">
          <button
            onClick={() => {
              void useAgentStore.getState().newSession();
            }}
            title={t("agent:newSession")}
            type="button"
          >
            {t("agent:newSession")}
          </button>
          <button
            aria-expanded={historyOpen}
            onClick={() =>
              useAgentStore.getState().setHistoryOpen(!historyOpen)
            }
            type="button"
          >
            {t("agent:history")}
          </button>
        </div>
      </header>

      <div className="agent-model">
        <label htmlFor={`agent-model-${room}`}>{t("agent:model.label")}</label>
        <select
          disabled={busy}
          id={`agent-model-${room}`}
          onChange={(event) =>
            useAgentStore.getState().setModel(event.target.value || null)
          }
          value={model ?? ""}
        >
          <option value="">
            {defaultModel
              ? t("agent:model.defaultNamed", { name: defaultModel.label })
              : t("agent:model.default")}
          </option>
          {models.map((option) => (
            <option key={option.reference} value={option.reference}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {historyOpen && <SessionsPanel />}

      {warnings.length > 0 && (
        <p className="agent-warning" title={warnings.join("\n")}>
          {t("agent:context.warnings")}
        </p>
      )}

      <ol className="agent-messages" data-testid="agent-messages">
        {messages.length === 0 && (
          <li className="agent-empty">
            <p>{t("agent:empty")}</p>
            <p className="agent-muted">{t("agent:emptyHint")}</p>
          </li>
        )}
        {messages.map((message) => (
          <Line key={message.id} message={message} />
        ))}
        <li ref={end} />
      </ol>

      {plan && plan.length > 0 && (
        <div className="agent-plan" data-testid="agent-plan">
          <p className="agent-plan-title">{t("agent:plan.title")}</p>
          <ol>
            {plan.map((item) => (
              <li className={`is-${item.status}`} key={item.id}>
                <span className="agent-plan-box" />
                {item.title}
              </li>
            ))}
          </ol>
        </div>
      )}

      {question && (
        <div className="agent-question" data-testid="agent-question">
          <p className="agent-question-title">{t("agent:question.title")}</p>
          <p>{question.question}</p>
          <div className="agent-question-actions">
            {question.options.map((option) => (
              <button
                key={option}
                onClick={() => useAgentStore.getState().answerQuestion(option)}
                type="button"
              >
                {option}
              </button>
            ))}
          </div>
          <form
            className="agent-question-other"
            onSubmit={(event) => {
              event.preventDefault();
              if (other.trim() === "") return;
              useAgentStore.getState().answerQuestion(other.trim());
              setOther("");
            }}
          >
            <input
              onChange={(event) => setOther(event.target.value)}
              placeholder={t("agent:question.other")}
              value={other}
            />
            <button type="submit">{t("agent:question.answer")}</button>
            <button
              onClick={() => useAgentStore.getState().dismissQuestion()}
              type="button"
            >
              {t("agent:question.dismiss")}
            </button>
          </form>
        </div>
      )}

      {approval && (
        <div className="agent-approval" data-testid="agent-approval">
          <p className="agent-approval-title">{t("agent:approval.title")}</p>
          <p className="agent-approval-tool">{approval.title}</p>
          <p className="agent-approval-risk">
            {t(
              RISK_KEYS[approval.risk as keyof typeof RISK_KEYS] ??
                "agent:approval.title",
            )}
          </p>
          {approval.risk === "destroy" && (
            <p className="agent-approval-irreversible">
              {t("agent:approval.irreversible")}
            </p>
          )}
          <pre className="agent-approval-input">
            {JSON.stringify(approval.input, null, 2)}
          </pre>
          <div className="agent-approval-actions">
            <button
              className="is-primary"
              onClick={() => useAgentStore.getState().approve()}
              type="button"
            >
              {t("agent:approval.approve")}
            </button>
            <button
              onClick={() => useAgentStore.getState().deny()}
              type="button"
            >
              {t("agent:approval.deny")}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="agent-error" role="alert">
          {error}
        </p>
      )}

      <form
        className="agent-composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          aria-label={t("agent:composer.placeholder")}
          disabled={busy}
          onChange={(event) =>
            useAgentStore.getState().setDraft(event.target.value)
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={t("agent:composer.placeholder")}
          rows={compact ? 2 : 3}
          value={draft}
        />
        <div className="agent-composer-actions">
          {busy ? (
            <button
              onClick={() => useAgentStore.getState().stop()}
              type="button"
            >
              {t("agent:composer.stop")}
            </button>
          ) : (
            <button
              className="is-primary"
              disabled={draft.trim() === ""}
              type="submit"
            >
              {t("agent:composer.send")}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
