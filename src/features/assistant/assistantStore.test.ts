import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssistantMessage,
  AssistantSession,
  DocumentCommand,
  MokaFile,
  NodeId,
  RunRecord,
  RunStatus,
  SessionId,
} from "../../shared/domain";
import {
  MAX_ASSISTANT_MESSAGES_PER_SESSION,
  MAX_ASSISTANT_TITLE_LENGTH,
} from "../../shared/domain";
import {
  buildGoldenMokaFile,
  goldenNodeIds,
} from "../../shared/domain/fixtures";
import { undo } from "../editor/commands/execute";
import { useEditorStore } from "../editor/stores/editorStore";
import { useHistoryStore } from "../editor/stores/historyStore";
import { useProjectStore } from "../editor/stores/projectStore";
import { useRunStore } from "../editor/stores/runStore";
import type { ModelsView } from "../../api";
import { useModelStore } from "../settings/modelStore";
import { useAssistantStore } from "./assistantStore";

/** A stream that can be fed a frame at a time, the way one arrives. */
function openStream() {
  const encoder = new TextEncoder();
  let control: ReadableStreamDefaultController<Uint8Array> | null = null;
  let over = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      control = controller;
    },
  });
  return {
    body,
    push: (frame: string) => {
      if (!over) control?.enqueue(encoder.encode(frame));
    },
    finish: () => {
      over = true;
      control?.close();
    },
    /** What a stopped fetch does to the read waiting on it. */
    cut: () => {
      if (over) return;
      over = true;
      control?.error(new DOMException("Aborted", "AbortError"));
    },
  };
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * A fetch that answers with a stream the test is still holding.
 *
 * Honouring the signal matters: a stub that ignored it could not be stopped,
 * and a turn that cannot be stopped cannot be shown to keep what had arrived.
 */
function stubStream() {
  const held = openStream();
  const fetchMock = vi.fn<typeof fetch>((_input, init) => {
    init?.signal?.addEventListener("abort", held.cut);
    return Promise.resolve(
      new Response(held.body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return { ...held, calls: fetchMock };
}

/** An answer that arrives whole and closes at once. */
function stubAnswer(said: string, closing?: Record<string, unknown>) {
  const held = stubStream();
  held.push(frame("delta", { text: said }));
  held.push(
    frame("done", {
      status: "succeeded",
      outputs: [],
      text: said,
      ...closing,
    }),
  );
  held.finish();
  return held;
}

function hydrate(moka?: MokaFile) {
  const document = moka ?? buildGoldenMokaFile();
  useProjectStore.getState().hydrate({
    root: "/tmp/moka-test",
    moka: document,
    selfCheck: { ok: true, issues: [] },
  });
  return document;
}

function board(moka: MokaFile) {
  return moka.canvas[0];
}

function sessionsOf() {
  const moka = useProjectStore.getState().moka;
  return moka?.canvas[0].sessions ?? [];
}

/**
 * The server a turn asked of a card goes over.
 *
 * Four calls, in an order that matters: the save that carries the card to disk,
 * the run built from it, the record read once it ends, and the document read that
 * brings what the run made. The last returns what the store is already holding,
 * which is what lets a test see whether a line written after the run landed on
 * the document the run changed or on the reading that was there before it.
 *
 * A run asked again from one that did not finish is served as its own record,
 * which is what a retry waits on rather than on the failure it came from.
 */
function stubRunServer(
  options: {
    status?: RunStatus;
    made?: number;
    stepError?: string;
    /** Keeps the record unreadable until the test says, so a wait can be stopped. */
    holdRecord?: boolean;
    /** What the run asked again from the first one comes back as. */
    retryStatus?: RunStatus;
    retryMade?: number;
  } = {},
) {
  const T = "2026-01-01T00:00:00.000Z";
  const runId = "r-asked";
  const againId = "r-asked-again";
  const order: string[] = [];
  const started: { nodeIds: NodeId[]; askedBy: SessionId | null } = {
    nodeIds: [],
    askedBy: null,
  };
  let land = () => {};
  let held: Promise<void> = Promise.resolve();
  const settled = options.status ?? "succeeded";

  const record = (status: RunStatus, id: string, made: number): RunRecord => ({
    id,
    projectId: "p-1",
    canvasId: board(useProjectStore.getState().moka!).id,
    requestedNodeIds: started.nodeIds,
    status,
    executorKey: "stub",
    graphHash: "h-1",
    parameters: {},
    assistantSessionId: started.askedBy ?? undefined,
    steps: started.nodeIds.map((nodeId) => ({
      nodeId,
      status,
      ...(options.stepError ? { error: options.stepError } : {}),
      ...(status === "succeeded" && made > 0
        ? {
            outputAssetIds: Array.from(
              { length: made },
              (_, at) => `asset-made-${at}`,
            ),
          }
        : {}),
    })),
    cancelRequested: status === "cancelled",
    createdAt: T,
    updatedAt: T,
  });

  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body =
      init?.body === undefined
        ? {}
        : (JSON.parse(init.body as string) as Record<string, unknown>);

    if (method === "POST" && path.endsWith("/projects/current/commands")) {
      order.push("commands");
      return json({ revision: 2, updatedAt: T });
    }
    if (method === "POST" && path.endsWith("/current/runs")) {
      order.push("start");
      started.nodeIds = body.nodeIds as NodeId[];
      started.askedBy = (body.assistantSessionId as SessionId) ?? null;
      if (options.holdRecord) {
        held = new Promise<void>((resolve) => {
          land = resolve;
        });
      }
      return json(record("queued", runId, 0));
    }
    if (method === "POST" && path.endsWith("/retry")) {
      order.push("retry");
      return json(record("queued", againId, 0));
    }
    if (method === "POST" && path.endsWith("/cancel")) {
      order.push("cancel");
      return json(record("cancelled", runId, 0));
    }
    if (method === "GET" && /\/current\/runs\/[^/]+$/.test(path)) {
      order.push("record");
      await held;
      const id = decodeURIComponent(path.split("/").pop() ?? "");
      const again = id === againId;
      return json(
        record(
          again ? (options.retryStatus ?? settled) : settled,
          id,
          again
            ? (options.retryMade ?? options.made ?? 0)
            : (options.made ?? 0),
        ),
      );
    }
    if (method === "GET" && path.endsWith("/projects/current")) {
      order.push("current");
      return json({
        root: "/tmp/moka-test",
        moka: useProjectStore.getState().moka,
        selfCheck: { ok: true, issues: [] },
      });
    }
    throw new Error(`Nothing was stubbed for ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { order, started, runId, againId, release: () => land() };
}

function cardOf(title: string) {
  const canvas = board(useProjectStore.getState().moka!);
  const found = canvas.nodes.find((node) => node.title === title);
  if (!found) throw new Error(`No card called ${title} on the canvas`);
  return found;
}

const WHEN = "2026-01-01T00:00:00.000Z";

/** A conversation holding this many lines, oldest first. */
function talked(
  id: string,
  title: string,
  lines: number,
  updatedAt = WHEN,
): AssistantSession {
  return {
    id,
    title,
    messages: Array.from({ length: lines }, (_, at) => ({
      id: `${id}-line-${at}`,
      role: "user" as const,
      text: `${title} line ${at}`,
      createdAt: WHEN,
    })),
    createdAt: WHEN,
    updatedAt,
  };
}

/**
 * Puts conversations in the document the way an opened project would hold them.
 *
 * Written through the command layer rather than by editing the fixture, so what
 * a test reads back afterwards is the same document the panel reads.
 */
function seed(...sessions: AssistantSession[]) {
  const canvas = board(useProjectStore.getState().moka!);
  useProjectStore.getState().applyLocal(
    sessions.map((session): DocumentCommand => ({
      type: "addSession",
      canvasId: canvas.id,
      session,
    })),
  );
  useHistoryStore.getState().clear();
}

/** Stands in for the browser's confirmation box, answering every time. */
function askedToConfirm(answer: boolean) {
  const asked = vi.fn(() => answer);
  vi.stubGlobal("window", { confirm: asked });
  return asked;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A configuration holding two text models and nothing of any other kind. */
function withTextModels(): ModelsView {
  return {
    version: 1,
    revision: 1,
    models: [
      {
        id: "kept-words",
        category: "text",
        protocol: "openaiChat",
        url: "https://api.test/chat",
        model: "kept-1",
        displayName: "Kept Words",
        enabled: true,
        apiKey: { set: true, masked: "****" },
      },
      {
        id: "plain-words",
        category: "text",
        protocol: "openaiChat",
        url: "https://api.test/chat2",
        model: "plain-1",
        displayName: "Plain Words",
        enabled: true,
        apiKey: { set: true, masked: "****" },
      },
    ],
    defaults: {
      text: null,
      image: null,
      speech: null,
      music: null,
      video: null,
      asr: null,
    },
    preferences: {
      systemPrompt: "",
      reasoningEffort: "auto",
      image: { size: "1:1", quality: "auto", background: "auto", count: 1 },
      video: {
        seconds: 8,
        resolution: "1080",
        generateAudio: true,
        watermark: false,
        mode: "auto",
        ratio: "16:9",
      },
      speech: {
        voice: "alloy",
        format: "mp3",
        speed: 1,
        instructions: "",
        sampleRate: 22050,
        volume: 50,
        rate: 1,
        pitch: 1,
      },
      music: { format: "mp3", watermark: false },
      story: { splitChars: 12_000, readChars: 8_000 },
    },
    secretStorage: "unset",
  };
}

beforeEach(() => {
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useRunStore.getState().reset();
  useAssistantStore.setState({
    intent: "answer",
    draft: "",
    asking: null,
    saying: "",
    busy: false,
    shown: "newest",
    history: null,
    model: null,
  });
  useModelStore.setState({ view: null });
  useEditorStore.setState({ announcement: "" });
});

afterEach(() => {
  useRunStore.getState().reset();
  useProjectStore.getState().close();
  vi.unstubAllGlobals();
});

describe("one turn", () => {
  it("writes itself down once, as one thing to undo", async () => {
    const moka = hydrate();
    const stream = stubAnswer("It floats over the lake.");
    useAssistantStore.getState().setDraft("What is happening here?");

    await useAssistantStore.getState().ask({ canvas: board(moka), chosen: [] });

    const held = sessionsOf();
    expect(held).toHaveLength(1);
    expect(held[0].messages.map((line) => line.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(held[0].messages[1].text).toBe("It floats over the lake.");
    // One turn, however many pieces it was shown in.
    expect(useProjectStore.getState().pending).toHaveLength(1);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    expect(stream.calls).toHaveBeenCalledTimes(1);
  });

  it("is named after what was first asked of it", async () => {
    const moka = hydrate();
    stubAnswer("So it does.");
    useAssistantStore.getState().setDraft("  What   is the lantern doing?  ");

    await useAssistantStore.getState().ask({ canvas: board(moka), chosen: [] });

    expect(sessionsOf()[0].title).toBe("What is the lantern doing?");
  });

  it("carries on in the conversation that was last talked in", async () => {
    const moka = hydrate();
    stubAnswer("First.");
    useAssistantStore.getState().setDraft("What is happening here?");
    await useAssistantStore.getState().ask({ canvas: board(moka), chosen: [] });

    // Read back out of the document, the way the panel does: the canvas handed
    // over before the first turn is one the first turn has already changed.
    stubAnswer("Second.");
    useAssistantStore.getState().setDraft("And the lake?");
    await useAssistantStore
      .getState()
      .ask({ canvas: board(useProjectStore.getState().moka!), chosen: [] });

    const held = sessionsOf();
    expect(held).toHaveLength(1);
    expect(held[0].messages.map((line) => line.text)).toEqual([
      "What is happening here?",
      "First.",
      "And the lake?",
      "Second.",
    ]);
    expect(useProjectStore.getState().pending).toHaveLength(2);
  });

  it("reaches nothing in the document while an answer is arriving", async () => {
    const moka = hydrate();
    const stream = stubStream();
    useAssistantStore.getState().setDraft("What is happening here?");

    const going = useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [] });
    stream.push(frame("delta", { text: "It floats" }));
    await flush();

    expect(sessionsOf()).toEqual([]);
    expect(useProjectStore.getState().pending).toEqual([]);
    // Shown, but not yet a line.
    expect(useAssistantStore.getState().saying).toBe("It floats");
    expect(useAssistantStore.getState().busy).toBe(true);

    stream.push(
      frame("done", {
        status: "succeeded",
        outputs: [],
        text: "It floats over.",
      }),
    );
    stream.finish();
    await going;

    expect(sessionsOf()[0].messages[1].text).toBe("It floats over.");
    expect(useAssistantStore.getState().saying).toBe("");
  });

  it("keeps what had arrived when it is stopped, and says so", async () => {
    const moka = hydrate();
    const stream = stubStream();
    useAssistantStore.getState().setDraft("What is happening here?");

    const going = useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [] });
    stream.push(frame("delta", { text: "It floats over" }));
    await flush();
    useAssistantStore.getState().stop();
    await going;

    const held = sessionsOf()[0];
    expect(held.messages[1].role).toBe("assistant");
    expect(held.messages[1].text).toBe("It floats over");
    expect(useAssistantStore.getState().busy).toBe(false);
  });

  it("records a turn stopped before anything came as one to ask again", async () => {
    const moka = hydrate();
    stubStream();
    useAssistantStore.getState().setDraft("What is happening here?");

    const going = useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [] });
    await flush();
    useAssistantStore.getState().stop();
    await going;

    const held = sessionsOf()[0];
    expect(held.messages[1].role).toBe("error");
    expect(held.messages[1].failure).toEqual({
      code: "GENERATION_CANCELLED",
      retryable: true,
    });
  });

  it("keeps a refusal as a line rather than losing the question", async () => {
    const moka = hydrate();
    const stream = stubStream();
    useAssistantStore.getState().setDraft("What is happening here?");

    const going = useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [] });
    stream.push(
      frame("done", {
        error: {
          code: "PROVIDER_RATE_LIMIT",
          message: "Too many asks at once.",
          retryable: true,
        },
      }),
    );
    stream.finish();
    await going;

    const held = sessionsOf()[0];
    expect(held.messages.map((line) => line.role)).toEqual(["user", "error"]);
    expect(held.messages[1].text).toBe("Too many asks at once.");
    expect(held.messages[1].failure).toEqual({
      code: "PROVIDER_RATE_LIMIT",
      retryable: true,
    });
    // A question that was asked is still a question that was asked.
    expect(useProjectStore.getState().pending).toHaveLength(1);
  });

  it("takes the whole answer rather than the pieces it was shown as", async () => {
    const moka = hydrate();
    const stream = stubStream();
    useAssistantStore.getState().setDraft("What is happening here?");

    const going = useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [] });
    stream.push(frame("delta", { text: "It floats " }));
    stream.push(frame("delta", { text: "over." }));
    stream.push(
      frame("done", {
        status: "succeeded",
        outputs: [],
        text: "It floats over the lake.",
      }),
    );
    stream.finish();
    await going;

    expect(sessionsOf()[0].messages[1].text).toBe("It floats over the lake.");
  });
});

describe("what is sent", () => {
  it("sends what the chosen card says, and names the card it came from", async () => {
    const moka = hydrate();
    const ids = goldenNodeIds();
    const stream = stubAnswer("So it does.");
    useAssistantStore.getState().setDraft("Is the brief about water?");

    await useAssistantStore.getState().ask({
      canvas: board(moka),
      chosen: [ids.text],
    });

    const sent = JSON.parse(stream.calls.mock.calls[0][1]!.body as string) as {
      prompt: string;
      capability: string;
    };
    expect(sent.capability).toBe("text");
    expect(sent.prompt).toContain("[Brief]");
    expect(sent.prompt).toContain(
      "A lantern floats over a quiet lake at dusk.",
    );
    expect(sessionsOf()[0].messages[0].references).toEqual([
      { nodeId: ids.text, title: "Brief", kind: "text" },
    ]);
  });

  it("sends a picture by the asset it holds rather than by its bytes", async () => {
    const moka = hydrate();
    const ids = goldenNodeIds();
    const stream = stubAnswer("A lantern.");
    useAssistantStore.getState().setDraft("What is in this one?");

    await useAssistantStore.getState().ask({
      canvas: board(moka),
      chosen: [ids.image],
    });

    const sent = JSON.parse(stream.calls.mock.calls[0][1]!.body as string) as {
      inputs: { role: string; assetId: string }[];
    };
    expect(sent.inputs).toEqual([
      { role: "reference", assetId: ids.assetImage },
    ]);
  });

  it("asks for a rewrite by saying so, and for nothing else back", async () => {
    const moka = hydrate();
    const stream = stubAnswer("A lantern drifts.");
    useAssistantStore.getState().setIntent("rewrite");
    useAssistantStore.getState().setDraft("Shorter.");

    await useAssistantStore.getState().ask({ canvas: board(moka), chosen: [] });

    const sent = JSON.parse(stream.calls.mock.calls[0][1]!.body as string) as {
      system: string;
    };
    expect(sent.system).toContain("Return only that text");
  });

  it("sends the model the panel picked, and no model when none is", async () => {
    const moka = hydrate();
    useModelStore.setState({ view: withTextModels() });
    const stream = stubAnswer("So it does.");
    useAssistantStore.getState().setModel("kept-words");
    useAssistantStore.getState().setDraft("Is the brief about water?");

    await useAssistantStore.getState().ask({ canvas: board(moka), chosen: [] });

    const sent = JSON.parse(stream.calls.mock.calls[0][1]!.body as string) as {
      model?: string;
    };
    expect(sent.model).toBe("kept-words");

    // Nothing picked is nothing sent: the deployment's own default answers.
    useAssistantStore.getState().setModel(null);
    useAssistantStore.getState().setDraft("And again?");
    await useAssistantStore.getState().ask({ canvas: board(moka), chosen: [] });
    const bare = JSON.parse(stream.calls.mock.calls[1][1]!.body as string) as {
      model?: string;
    };
    expect(bare.model).toBeUndefined();
  });

  it("falls back to the default where the model picked has gone", async () => {
    const moka = hydrate();
    useModelStore.setState({ view: withTextModels() });
    const stream = stubAnswer("So it does.");
    // A pick naming a model the configuration no longer holds is no pick at
    // all: the ask falls back to the default rather than being refused for
    // a model that went.
    useAssistantStore.getState().setModel("a-model-taken-away");
    useAssistantStore.getState().setDraft("Is the brief about water?");

    await useAssistantStore.getState().ask({ canvas: board(moka), chosen: [] });

    const sent = JSON.parse(stream.calls.mock.calls[0][1]!.body as string) as {
      model?: string;
    };
    expect(sent.model).toBeUndefined();
  });

  it("carries the lines before the question only once they are asked for", async () => {
    const moka = hydrate();
    stubAnswer("First.");
    useAssistantStore.getState().setDraft("What is happening?");
    await useAssistantStore.getState().ask({ canvas: board(moka), chosen: [] });

    const second = stubAnswer("Second.");
    useAssistantStore.getState().setDraft("And the lake?");
    await useAssistantStore.getState().ask({
      canvas: board(useProjectStore.getState().moka!),
      chosen: [],
    });
    const bare = JSON.parse(second.calls.mock.calls[0][1]!.body as string) as {
      prompt: string;
    };
    expect(bare.prompt).not.toContain("Earlier in this conversation");

    useAssistantStore.getState().setHistory(2);
    const third = stubAnswer("Third.");
    useAssistantStore.getState().setDraft("And the lantern?");
    await useAssistantStore.getState().ask({
      canvas: board(useProjectStore.getState().moka!),
      chosen: [],
    });
    const carried = JSON.parse(
      third.calls.mock.calls[0][1]!.body as string,
    ) as {
      prompt: string;
    };
    // The last two things said, not the turn before them: a conversation is a
    // long thing to send and the reader chose how much of it was worth it.
    expect(carried.prompt).toContain(
      "Earlier in this conversation:\nYou: And the lake?\nAssistant: Second.",
    );
    expect(carried.prompt).not.toContain("You: What is happening?");
    expect(carried.prompt.endsWith("And the lantern?")).toBe(true);
  });
});

describe("what is not sent", () => {
  it("asks nothing when nothing has been typed", async () => {
    const moka = hydrate();
    const stream = stubAnswer("Nobody asked.");
    useAssistantStore.getState().setDraft("   ");

    await useAssistantStore.getState().ask({ canvas: board(moka), chosen: [] });

    expect(stream.calls).not.toHaveBeenCalled();
    expect(sessionsOf()).toEqual([]);
    expect(useProjectStore.getState().pending).toEqual([]);
  });

  it("sends one ask at a time", async () => {
    const moka = hydrate();
    const stream = stubStream();
    useAssistantStore.getState().setDraft("What is happening here?");

    const first = useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [] });
    useAssistantStore.getState().setDraft("And then?");
    const second = useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [] });

    await second;
    // The second was not sent into the middle of the first: it would have been
    // written down as an answer to a question that had not been answered yet.
    expect(stream.calls).toHaveBeenCalledTimes(1);
    expect(useAssistantStore.getState().busy).toBe(true);

    stream.push(
      frame("done", { status: "succeeded", outputs: [], text: "It floats." }),
    );
    stream.finish();
    await first;
    expect(sessionsOf()[0].messages).toHaveLength(2);
  });
});

describe("a turn asked of a card", () => {
  it("puts the card on the canvas and records what the run made", async () => {
    const moka = hydrate();
    const ids = goldenNodeIds();
    const asked = "A wider shot of the lake";
    const server = stubRunServer({ made: 1 });
    useAssistantStore.getState().setIntent("image");
    useAssistantStore.getState().setDraft(asked);

    await useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [ids.text] });

    const canvas = board(useProjectStore.getState().moka!);
    const card = cardOf(asked);
    expect(card.kind).toBe("image");
    expect(
      (card.data as { generation: { prompt: string } }).generation.prompt,
    ).toBe(asked);
    // What the ask was about reaches the generation over the graph, which is
    // why the card is wired before it is run.
    const wires = canvas.edges.filter((edge) => edge.target.nodeId === card.id);
    expect(wires.map((edge) => edge.source.nodeId)).toEqual([ids.text]);

    const held = sessionsOf()[0];
    expect(held.title).toBe(asked);
    expect(held.messages.map((line) => line.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(held.messages[1].text).toBe("Made 1 image");
    expect(held.messages[1].toolCalls).toEqual([
      { runId: server.runId, nodeId: card.id, summary: "Made 1 image" },
    ]);

    // The run is built from the document on disk, so the card has to be saved
    // before it is asked to drive anything — and what the run made arrives by
    // that document being read back, which the line has to wait for.
    expect(server.order).toEqual(["commands", "start", "record", "current"]);
    expect(server.started.nodeIds).toEqual([card.id]);
    // Filed with the conversation that asked, which is whose the answer is.
    expect(server.started.askedBy).toBe(held.id);
    // The card and the conversation are separate things to undo: taking back
    // what was said should not quietly delete a picture that was paid for.
    expect(useHistoryStore.getState().undoStack).toHaveLength(2);
  });

  it("leaves a card that reached nothing out of what the turn was about", async () => {
    const moka = hydrate();
    const ids = goldenNodeIds();
    stubRunServer({ made: 1 });
    useAssistantStore.getState().setIntent("audio");
    useAssistantStore.getState().setDraft("Read it aloud");

    await useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [ids.image] });

    // A sound card takes words, so the picture named contributed nothing to what
    // came back, and the line does not claim it did.
    expect(cardOf("Read it aloud").kind).toBe("audio");
    const canvas = board(useProjectStore.getState().moka!);
    expect(canvas.edges).toHaveLength(board(moka).edges.length);
    expect(sessionsOf()[0].messages[0].references).toBeUndefined();
    expect(sessionsOf()[0].messages[1].text).toBe("Made 1 sound");
  });

  it("keeps a card whose run did not finish as one to ask again from", async () => {
    const moka = hydrate();
    const ids = goldenNodeIds();
    const asked = "A wider shot of the lake";
    stubRunServer({
      status: "failed",
      stepError: "No model would take the ask.",
    });
    useAssistantStore.getState().setIntent("image");
    useAssistantStore.getState().setDraft(asked);

    await useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [ids.text] });

    // The card stays where it landed: it is the asking again, and it was paid
    // for by the run that did not come back.
    expect(cardOf(asked).kind).toBe("image");
    const line = sessionsOf()[0].messages[1];
    expect(line.role).toBe("error");
    expect(line.text).toBe("No model would take the ask.");
    expect(line.failure).toEqual({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    expect(line.toolCalls?.[0].summary).toBe("Made nothing");
  });

  it("asks the run to give up rather than only stopping the waiting", async () => {
    const moka = hydrate();
    const ids = goldenNodeIds();
    const server = stubRunServer({
      status: "cancelled",
      holdRecord: true,
    });
    useAssistantStore.getState().setIntent("image");
    useAssistantStore.getState().setDraft("A wider shot");

    const going = useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [ids.text] });
    await flush();
    useAssistantStore.getState().stop();
    await going;
    server.release();
    await flush();

    // Aborting the ask alone would leave the generation being paid for behind a
    // panel that had stopped looking at it.
    expect(server.order).toContain("cancel");
    const line = sessionsOf()[0].messages[1];
    expect(line.role).toBe("error");
    expect(line.text).toBe("Stopped. The card is on the canvas to ask again.");
    expect(line.failure).toEqual({
      code: "GENERATION_CANCELLED",
      retryable: true,
    });
  });
});

describe("the conversation a turn is written to", () => {
  it("carries on the one the panel is reading, not simply the newest", async () => {
    hydrate();
    seed(
      talked("s-old", "The first ask", 2, "2026-01-01T00:00:00.000Z"),
      talked("s-new", "The later ask", 2, "2026-06-06T00:00:00.000Z"),
    );
    useAssistantStore.getState().show("s-old");
    stubAnswer("Still the first one.");
    useAssistantStore.getState().setDraft("Back to the first ask?");

    await useAssistantStore.getState().ask({
      canvas: board(useProjectStore.getState().moka!),
      chosen: [],
    });

    const held = sessionsOf();
    expect(
      held.find((session) => session.id === "s-old")?.messages,
    ).toHaveLength(4);
    expect(
      held.find((session) => session.id === "s-new")?.messages,
    ).toHaveLength(2);
    expect(useAssistantStore.getState().shown).toBe("s-old");
  });

  it("leaves the panel reading the conversation a turn opened", async () => {
    const moka = hydrate();
    useAssistantStore.getState().show("fresh");
    stubAnswer("First.");
    useAssistantStore.getState().setDraft("What is happening here?");
    await useAssistantStore.getState().ask({ canvas: board(moka), chosen: [] });

    expect(sessionsOf()).toHaveLength(1);
    const opened = sessionsOf()[0].id;
    expect(useAssistantStore.getState().shown).toBe(opened);

    // Asked again without another word about it, the turn belongs to the
    // conversation it opened rather than to a second one beside it.
    stubAnswer("Second.");
    useAssistantStore.getState().setDraft("And the lake?");
    await useAssistantStore.getState().ask({
      canvas: board(useProjectStore.getState().moka!),
      chosen: [],
    });

    expect(sessionsOf()).toHaveLength(1);
    expect(sessionsOf()[0].messages).toHaveLength(4);
  });

  it("says when a turn cost a conversation its oldest lines", async () => {
    hydrate();
    seed(
      talked("s-full", "A long talk", MAX_ASSISTANT_MESSAGES_PER_SESSION - 1),
    );
    stubAnswer("So it does.");
    useAssistantStore.getState().setDraft("And the lake?");

    await useAssistantStore.getState().ask({
      canvas: board(useProjectStore.getState().moka!),
      chosen: [],
    });

    expect(sessionsOf()).toHaveLength(1);
    const held = sessionsOf()[0].messages;
    expect(held).toHaveLength(MAX_ASSISTANT_MESSAGES_PER_SESSION);
    expect(held[0].text).toBe("A long talk line 1");
    expect(useEditorStore.getState().announcement).toBe(
      "1 old line let go to keep the conversation readable. Undo brings it back.",
    );
  });
});

describe("keeping the conversations", () => {
  it("gives one another name, as one thing to undo", () => {
    hydrate();
    seed(talked("s-1", "The first ask", 3));

    useAssistantStore
      .getState()
      .rename(
        board(useProjectStore.getState().moka!),
        "s-1",
        "  The lantern  ",
      );

    expect(sessionsOf()[0].title).toBe("The lantern");
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    expect(undo()).toBe(true);
    expect(sessionsOf()[0].title).toBe("The first ask");
  });

  it("cuts a name to the length the document allows", () => {
    hydrate();
    seed(talked("s-1", "The first ask", 1));

    useAssistantStore
      .getState()
      .rename(board(useProjectStore.getState().moka!), "s-1", "n".repeat(400));

    expect(sessionsOf()[0].title).toHaveLength(MAX_ASSISTANT_TITLE_LENGTH);
  });

  it("leaves a conversation alone when the name says nothing new", () => {
    hydrate();
    seed(talked("s-1", "The first ask", 1));
    const assistant = useAssistantStore.getState();
    const canvas = board(useProjectStore.getState().moka!);

    assistant.rename(canvas, "s-1", "   ");
    assistant.rename(canvas, "s-1", "The first ask");
    assistant.rename(canvas, "gone", "Renamed anyway");

    expect(sessionsOf().map((session) => session.title)).toEqual([
      "The first ask",
    ]);
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
  });

  it("takes one conversation away, lines and all, and gives it back", () => {
    hydrate();
    seed(talked("s-1", "The first ask", 3), talked("s-2", "The second", 1));
    const asked = askedToConfirm(true);

    useAssistantStore
      .getState()
      .remove(board(useProjectStore.getState().moka!), "s-1");

    expect(asked).toHaveBeenCalledWith(
      "Delete “The first ask” and its 3 lines?",
    );
    expect(sessionsOf().map((session) => session.id)).toEqual(["s-2"]);
    expect(undo()).toBe(true);
    expect(sessionsOf().map((session) => session.id)).toEqual(["s-1", "s-2"]);
    expect(sessionsOf()[0].messages).toHaveLength(3);
  });

  it("leaves a conversation alone when the answer is no", () => {
    hydrate();
    seed(talked("s-1", "The first ask", 3));
    askedToConfirm(false);

    useAssistantStore
      .getState()
      .remove(board(useProjectStore.getState().moka!), "s-1");

    expect(sessionsOf()).toHaveLength(1);
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
  });

  it("takes every conversation away as one thing to undo", () => {
    hydrate();
    seed(talked("s-1", "The first ask", 2), talked("s-2", "The second", 3));
    const asked = askedToConfirm(true);

    useAssistantStore
      .getState()
      .removeEvery(board(useProjectStore.getState().moka!));

    expect(asked).toHaveBeenCalledWith(
      "Delete all 2 conversations and their 5 lines?",
    );
    expect(sessionsOf()).toEqual([]);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    expect(undo()).toBe(true);
    expect(sessionsOf().map((session) => session.title)).toEqual([
      "The first ask",
      "The second",
    ]);
  });

  it("asks nothing to confirm when there is nothing to take away", () => {
    const moka = hydrate();
    const asked = askedToConfirm(true);

    useAssistantStore.getState().removeEvery(board(moka));

    expect(asked).not.toHaveBeenCalled();
  });
});

describe("asking a card again", () => {
  it("keeps only the answer, on the run the retry made", async () => {
    const moka = hydrate();
    const ids = goldenNodeIds();
    const asked = "A wider shot of the lake";
    const server = stubRunServer({
      status: "failed",
      stepError: "No model would take the ask.",
      retryStatus: "succeeded",
      retryMade: 2,
    });
    useAssistantStore.getState().setIntent("image");
    useAssistantStore.getState().setDraft(asked);
    await useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [ids.text] });

    const card = cardOf(asked);
    const held = sessionsOf()[0];
    const failed = held.messages[1];
    expect(failed.role).toBe("error");
    const confirm = askedToConfirm(true);

    await useAssistantStore
      .getState()
      .retry(board(useProjectStore.getState().moka!), held.id, failed);

    expect(confirm).toHaveBeenCalledWith(
      `Ask “${asked}” to make it again? The card is already on the canvas, so only the making is paid for.`,
    );
    // The question is already the line above, so a retry adds an answer and
    // nothing else: a second question would read as a second ask.
    const lines = sessionsOf()[0].messages;
    expect(lines.map((line) => line.role)).toEqual([
      "user",
      "error",
      "assistant",
    ]);
    expect(lines[2].text).toBe("Made 2 images");
    expect(lines[2].toolCalls).toEqual([
      { runId: server.againId, nodeId: card.id, summary: "Made 2 images" },
    ]);
    // The card that stands is the one asked again — no second one was made.
    expect(
      board(useProjectStore.getState().moka!).nodes.filter(
        (node) => node.title === asked,
      ),
    ).toHaveLength(1);
    expect(server.order).toContain("retry");
    expect(useHistoryStore.getState().undoStack).toHaveLength(3);
    expect(undo()).toBe(true);
    expect(sessionsOf()[0].messages).toHaveLength(2);
  });

  it("says so when the card an answer named has gone", async () => {
    hydrate();
    seed(talked("s-1", "The first ask", 1));
    const server = stubRunServer();
    const asked = askedToConfirm(true);
    const ghost: AssistantMessage = {
      id: "m-ghost",
      role: "error",
      text: "The card did not come back with anything",
      createdAt: WHEN,
      toolCalls: [
        { runId: "r-gone", nodeId: "n-gone", summary: "Made nothing" },
      ],
      failure: { code: "PROVIDER_UNAVAILABLE", retryable: true },
    };

    await useAssistantStore
      .getState()
      .retry(board(useProjectStore.getState().moka!), "s-1", ghost);

    expect(asked).not.toHaveBeenCalled();
    expect(server.order).not.toContain("retry");
    expect(sessionsOf()[0].messages).toHaveLength(1);
    expect(useEditorStore.getState().announcement).toBe(
      "The card that answer named is no longer on the canvas",
    );
  });

  it("writes nothing when the retry is answered no", async () => {
    const moka = hydrate();
    const ids = goldenNodeIds();
    const asked = "A wider shot of the lake";
    const server = stubRunServer({
      status: "failed",
      stepError: "No model would take the ask.",
    });
    useAssistantStore.getState().setIntent("image");
    useAssistantStore.getState().setDraft(asked);
    await useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [ids.text] });

    askedToConfirm(false);
    const held = sessionsOf()[0];
    await useAssistantStore
      .getState()
      .retry(
        board(useProjectStore.getState().moka!),
        held.id,
        held.messages[1],
      );

    // A second failure line for one ask that never started would be two things
    // to read about nothing having happened.
    expect(server.order).not.toContain("retry");
    expect(sessionsOf()[0].messages).toHaveLength(2);
    expect(useAssistantStore.getState().busy).toBe(false);
  });
});
