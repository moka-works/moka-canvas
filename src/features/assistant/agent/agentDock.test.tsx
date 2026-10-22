// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDock } from "./AgentDock";
import { useModelStore } from "../../settings/modelStore";
import { useAgentStore } from "./agentStore";
import { requestApproval, requestQuestion } from "./interaction";

const catalog = {
  catalogVersion: "test",
  catalogHash: "sha256:test",
  packs: [],
  tools: [],
};

function storeBody(url: string): unknown {
  if (url.startsWith("/api/v1/agent/tools")) return catalog;
  if (url.startsWith("/api/v1/agent/capabilities")) {
    return { ...catalog, surfaces: [], toolCount: 0 };
  }
  if (url.startsWith("/api/v1/agent/sessions")) return { sessions: [] };
  if (url.startsWith("/api/v1/models")) {
    return {
      version: 1,
      revision: 0,
      models: [],
      defaults: {
        text: null,
        image: null,
        speech: null,
        music: null,
        video: null,
        asr: null,
      },
      preferences: {},
    };
  }
  return {};
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(JSON.stringify(storeBody(url)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  useModelStore.setState({ view: null });
  useAgentStore.setState({
    room: "canvas",
    sessions: [],
    session: null,
    messages: [],
    busy: false,
    draft: "",
    error: null,
    contextLine: null,
    warnings: [],
    plan: null,
    approval: null,
    question: null,
    historyOpen: false,
  });
});

describe("AgentDock", () => {
  it("shows the room's empty state and sends what is typed", () => {
    const send = vi.fn();
    useAgentStore.setState({ send });
    render(<AgentDock room="canvas" />);
    expect(screen.getByTestId("agent-dock")).toHaveAttribute(
      "data-room",
      "canvas",
    );
    expect(
      screen.getByText("Ask for a change, or ask what is here."),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Ask the assistant…"), {
      target: { value: "trim the first clip" },
    });
    fireEvent.click(screen.getByText("Send"));
    expect(send).toHaveBeenCalled();
  });

  it("draws a tool record and says how it can be undone", () => {
    useAgentStore.setState({
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "I trimmed it.",
          createdAt: "2026-10-21T09:00:00Z",
          toolCalls: [
            {
              id: "call_1",
              name: "clip.trim",
              kind: "command",
              risk: "write",
              input: { timelineId: "tl_1" },
              status: "ok",
              result: {
                ok: true,
                summary: "Trimmed 2 clips",
                changeSetId: "cs_1",
              },
            },
          ],
        },
      ],
    });
    render(<AgentDock room="clip" />);
    expect(screen.getByText("Trimmed 2 clips")).toBeInTheDocument();
    expect(screen.getByText("Can be undone with Ctrl+Z")).toBeInTheDocument();
  });

  it("stops for approval and resolves the loop's promise", async () => {
    render(<AgentDock room="assets" />);
    let approved!: Promise<boolean>;
    act(() => {
      approved = requestApproval({
        tool: "asset.delete",
        title: "delete",
        description: "Delete an asset",
        risk: "destroy",
        input: { assetIds: ["a_1"] },
      });
    });
    await screen.findByTestId("agent-approval");
    expect(
      screen.getByText(
        "This cannot be undone. The input below is exactly what will run.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Allow"));
    await expect(approved).resolves.toBe(true);
    await waitFor(() =>
      expect(screen.queryByTestId("agent-approval")).toBeNull(),
    );
  });

  it("answers a question with an option or with something else", async () => {
    render(<AgentDock room="story" />);
    let answered!: Promise<string | null>;
    act(() => {
      answered = requestQuestion({
        question: "Delete the three unused takes?",
        options: ["Delete", "Keep"],
      });
    });
    await screen.findByTestId("agent-question");
    fireEvent.click(screen.getByText("Keep"));
    await expect(answered).resolves.toBe("Keep");
  });

  it("lets the reader pick the model this conversation answers with", () => {
    useModelStore.setState({
      view: {
        version: 1,
        revision: 0,
        models: [
          {
            id: "writer",
            category: "text",
            protocol: "openaiChat",
            url: "http://example/v1/chat/completions",
            model: "writer",
            displayName: "Writer",
            enabled: true,
          },
        ],
        defaults: { text: "writer" },
        preferences: {},
      } as never,
    });
    render(<AgentDock room="canvas" />);
    const select = screen.getByLabelText("Model");
    expect(select).toHaveValue("");
    fireEvent.change(select, { target: { value: "writer" } });
    expect(useAgentStore.getState().model).toBe("writer");
    expect(select).toHaveValue("writer");
  });

  it("draws the plan the model is keeping", () => {
    useAgentStore.setState({
      plan: [
        { id: "p1", title: "Read the timeline", status: "done" },
        { id: "p2", title: "Trim the clips", status: "doing" },
      ],
    });
    render(<AgentDock room="clip" />);
    expect(screen.getByTestId("agent-plan")).toHaveTextContent(
      "Trim the clips",
    );
  });
});
