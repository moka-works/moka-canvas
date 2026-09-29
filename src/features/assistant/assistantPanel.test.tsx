// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ModelsView } from "../../api";
import type {
  AssistantMessage,
  AssistantRole,
  AssistantSession,
  MokaFile,
  WorkflowNode,
} from "../../shared/domain";
import {
  buildConversationMokaFile,
  buildGoldenMokaFile,
  conversationIds,
  goldenNodeIds,
} from "../../shared/domain/fixtures";
import { mentionToken } from "../editor/canvas/mentions";
import { undo } from "../editor/commands/execute";
import { useEditorStore } from "../editor/stores/editorStore";
import { useHistoryStore } from "../editor/stores/historyStore";
import { useProjectStore } from "../editor/stores/projectStore";
import { useModelStore } from "../settings/modelStore";
import { AssistantPanel } from "./AssistantPanel";
import { earlierWords } from "./asking";
import { useAssistantStore } from "./assistantStore";

const ids = goldenNodeIds();
const said = conversationIds();
const T = "2026-01-01T00:00:00.000Z";

const NOTHING_CARRIED = "Nothing said before this question is sent with it";

function hydrate(document: MokaFile) {
  useProjectStore.getState().hydrate({
    root: "/tmp/moka-panel-test",
    moka: document,
    selfCheck: { ok: true, issues: [] },
  });
}

/** The document as the store holds it now, after anything the panel wrote. */
function held(): MokaFile {
  const document = useProjectStore.getState().moka;
  if (!document) throw new Error("no document is open");
  return document;
}

function cards(): readonly WorkflowNode[] {
  return held().canvas[0].nodes;
}

function wordsOn(nodeId: string): string {
  const card = cards().find((node) => node.id === nodeId);
  const data = card?.data as { content?: string } | undefined;
  return data?.content ?? "";
}

/** Take a card off the canvas the way the server would, by rewriting the document. */
function burn(nodeId: string) {
  const document = held();
  act(() =>
    useProjectStore.setState({
      moka: {
        ...document,
        canvas: document.canvas.map((canvas) =>
          canvas.id === ids.canvasMain
            ? {
                ...canvas,
                nodes: canvas.nodes.filter((node) => node.id !== nodeId),
              }
            : canvas,
        ),
      },
    }),
  );
}

let made = 0;
function line(
  role: AssistantRole,
  words: string,
  extra: Partial<AssistantMessage> = {},
): AssistantMessage {
  made += 1;
  return { id: `m-${made}`, role, text: words, createdAt: T, ...extra };
}

/** The golden canvas, holding a conversation of the lines given. */
function talking(...messages: AssistantMessage[]): MokaFile {
  const document = buildGoldenMokaFile();
  const session: AssistantSession = {
    id: said.session,
    title: "Held",
    messages,
    createdAt: T,
    updatedAt: T,
  };
  document.canvas[0].sessions = [session];
  return document;
}

/** A configuration with nothing in it, as a board straight off an install reads. */
function bare(): ModelsView {
  return {
    version: 1,
    revision: 1,
    models: [],
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

/** A configuration holding two text models the quick switch can offer. */
function configured(): ModelsView {
  const view = bare();
  view.models = [
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
  ];
  return view;
}

function choose(...nodeIds: string[]) {
  act(() => useEditorStore.getState().setSelection({ nodeIds, edgeIds: [] }));
}

function type(words: string) {
  const area = field();
  area.textContent = words;
  fireEvent.input(area);
}

function field(): HTMLElement {
  return screen.getByLabelText("Ask about this canvas");
}

/** The lines the panel is holding, oldest first, and nothing nested inside them. */
function shown(): HTMLElement[] {
  return Array.from(
    screen.getByTestId("assistant-lines").querySelectorAll(".assistant-line"),
  );
}

function about(): string {
  return screen.getByTestId("assistant-about").textContent ?? "";
}

function note(): string {
  return screen.getByTestId("assistant-history-note").textContent ?? "";
}

beforeEach(() => {
  made = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("{}", { status: 200 }))),
  );
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
  useHistoryStore.getState().clear();
  useEditorStore.getState().clearSelection();
  useModelStore.setState({ view: null, open: false, tab: "text" });
});

afterEach(() => {
  cleanup();
  useProjectStore.getState().close();
  useAssistantStore.getState().stop();
  vi.unstubAllGlobals();
});

describe("what a turn is about", () => {
  it("counts the cards above the chosen one in, not only the chosen one", () => {
    hydrate(buildGoldenMokaFile());
    render(<AssistantPanel />);

    expect(about()).toBe(
      "About nothing yet — choose a card, or name one with @",
    );

    choose(ids.operation);
    expect(about()).toBe("About 1 text");

    // A picture that feeds nothing and is fed by nothing is about itself alone.
    choose(ids.image);
    expect(about()).toBe("About 1 image");
  });

  it("takes in a card named with @ as well as the cards chosen", () => {
    hydrate(buildGoldenMokaFile());
    render(<AssistantPanel />);

    choose(ids.image);
    type(`${mentionToken(ids.text)} and this?`);

    expect(about()).toBe("About 1 text · 1 image");
  });

  it("says so when there is no canvas to be about", () => {
    useProjectStore.getState().close();
    render(<AssistantPanel />);

    expect(screen.getByText("No canvas is open").className).toContain(
      "prompt-panel-note",
    );
  });
});

describe("what a kept line can be done with", () => {
  it("writes an answer onto the canvas as a card of its own", () => {
    hydrate(
      talking(
        line("user", "What is over the lake?"),
        line("assistant", "A lantern, drifting over it at dusk."),
      ),
    );
    render(<AssistantPanel />);

    const before = cards().length;
    fireEvent.click(screen.getByRole("button", { name: "Insert on canvas" }));

    const added = cards().filter(
      (node) => node.kind === "text" && node.id !== ids.text,
    );
    expect(added).toHaveLength(1);
    expect(wordsOn(added[0].id)).toBe("A lantern, drifting over it at dusk.");

    undo();
    expect(cards()).toHaveLength(before);
  });

  it("puts the answer over the text card already chosen", () => {
    hydrate(
      talking(
        line("user", "What is over the lake?"),
        line("assistant", "A lantern, drifting over it at dusk."),
      ),
    );
    choose(ids.text);
    render(<AssistantPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Replace selection" }));

    expect(wordsOn(ids.text)).toBe("A lantern, drifting over it at dusk.");
    // Only the one card holds it: nothing was placed beside it as well.
    expect(cards().filter((node) => node.kind === "text")).toHaveLength(1);
  });

  it("points a line that made something back at the card and the assets", () => {
    hydrate(buildConversationMokaFile());
    render(<AssistantPanel />);

    const answered = shown()[1];
    expect(
      within(answered).getByRole("button", { name: "Show on canvas" }),
    ).toBeTruthy();
    expect(
      within(answered).getByRole("button", { name: "Show in assets" }),
    ).toBeTruthy();
    // A turn that already left the panel has no words outlet to offer again.
    expect(within(answered).queryByText("Insert on canvas")).toBeNull();

    fireEvent.click(
      within(answered).getByRole("button", { name: "Show on canvas" }),
    );
    expect(useEditorStore.getState().selection.nodeIds).toEqual([ids.image]);
  });

  it("offers a card that came back empty to be made again, and asks first", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    hydrate(
      talking(
        line("user", "Paint it at dawn."),
        line("assistant", "The painter did not answer.", {
          toolCalls: [
            { runId: said.run, nodeId: ids.image, summary: "Painted a poster" },
          ],
          failure: { code: "PROVIDER_UNAVAILABLE", retryable: true },
        }),
      ),
    );
    render(<AssistantPanel />);

    const failed = shown()[1];
    fireEvent.click(
      within(failed).getByRole("button", { name: "Ask the card again" }),
    );
    expect(confirm).toHaveBeenCalled();
    // Refused at the asking: nothing was written and nothing was set going.
    expect(held().canvas[0].sessions?.[0].messages).toHaveLength(2);
    expect(useAssistantStore.getState().busy).toBe(false);
  });

  it("had a question back into the field rather than sending it again", () => {
    hydrate(talking(line("user", "What is over the lake?")));
    render(<AssistantPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Ask again" }));

    expect(field().textContent).toBe("What is over the lake?");
    expect(useAssistantStore.getState().busy).toBe(false);
    expect(useAssistantStore.getState().draft).toBe("What is over the lake?");
  });

  it("says which of its lines was trouble, and had that question back", () => {
    hydrate(
      talking(
        line("user", "What is over the lake?"),
        line("error", "The painter did not answer.", {
          failure: { code: "PROVIDER_UNAVAILABLE", retryable: true },
        }),
      ),
    );
    render(<AssistantPanel />);

    const trouble = shown()[1];
    expect(trouble.className).toContain("is-error");
    fireEvent.click(within(trouble).getByRole("button", { name: "Ask again" }));
    expect(field().textContent).toBe("What is over the lake?");
  });
});

describe("a conversation longer than the column", () => {
  it("folds the oldest lines away and steps back for them", () => {
    hydrate(
      talking(
        ...Array.from({ length: 60 }, (_, at) =>
          line(at % 2 === 0 ? "user" : "assistant", `Line ${at}`),
        ),
      ),
    );
    render(<AssistantPanel />);

    expect(shown()).toHaveLength(50);
    expect(screen.queryByText("Line 59")).not.toBeNull();
    expect(screen.queryByText("Line 0")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Show 10 earlier lines" }),
    );

    expect(shown()).toHaveLength(60);
    expect(screen.queryByRole("button", { name: /earlier lines/ })).toBeNull();
  });

  it("keeps a card that has gone off the canvas in the line that named it", () => {
    hydrate(
      talking(
        line("user", "What is over the lake?", {
          references: [
            { nodeId: ids.image, title: "Reference image", kind: "image" },
            { nodeId: ids.export, title: "Export", kind: "export" },
          ],
        }),
      ),
    );
    render(<AssistantPanel />);

    const list = () =>
      within(
        within(shown()[0]).getByLabelText("What this was about"),
      ).getAllByRole("listitem");
    expect(list()[0].textContent).toBe("Reference image");
    expect(list()[0].className).toBe("");

    burn(ids.image);

    expect(list()).toHaveLength(2);
    expect(list()[0].textContent).toBe("Reference image — gone");
    expect(list()[0].className).toContain("is-gone");
    expect(list()[0].getAttribute("title")).toBe(
      "This card is no longer on the canvas",
    );
    expect(list()[1].textContent).toBe("Export");
  });
});

describe("sending what was said before", () => {
  it("costs nothing until it is asked for, and then says what it costs", () => {
    const messages = [
      line("user", "What is over the lake?"),
      line("assistant", "A lantern, drifting over it at dusk."),
      line("user", "And the near shore?"),
      line("assistant", "Reeds, and nobody about."),
    ];
    hydrate(talking(...messages));
    render(<AssistantPanel />);

    expect(note()).toBe(NOTHING_CARRIED);

    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(note()).toBe(
      `About ${
        earlierWords(messages, 2).length
      } characters of this conversation go with the ask`,
    );

    // Picked out again, and the memory is off rather than merely emptied.
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(note()).toBe(NOTHING_CARRIED);
    expect(useAssistantStore.getState().history).toBeNull();
  });

  it("has a card ask go without memory, since a run reads the canvas", () => {
    hydrate(talking(line("user", "What is over the lake?")));
    render(<AssistantPanel />);

    expect(screen.getByText("Send earlier lines with this")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Image" }));
    expect(screen.queryByText("Send earlier lines with this")).toBeNull();
  });
});

describe("the model answering in words", () => {
  it("offers every configured text model, and keeps the one picked", () => {
    hydrate(buildGoldenMokaFile());
    useModelStore.setState({ view: configured() });
    render(<AssistantPanel />);

    const select = screen.getByTestId("assistant-model");
    const names = Array.from((select as HTMLSelectElement).options).map(
      (option) => option.text,
    );
    expect(names).toEqual(["Default model", "Kept Words", "Plain Words"]);
    expect((select as HTMLSelectElement).value).toBe("");

    fireEvent.change(select, { target: { value: "kept-words" } });
    expect(useAssistantStore.getState().model).toBe("kept-words");
    expect((select as HTMLSelectElement).value).toBe("kept-words");

    // A card is asked through a run, which reads the model off the card's
    // own spec: the quick switch belongs to the turns answered in words.
    fireEvent.click(screen.getByRole("button", { name: "Image" }));
    expect(screen.queryByTestId("assistant-model")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(
      (screen.getByTestId("assistant-model") as HTMLSelectElement).value,
    ).toBe("kept-words");
  });

  it("reads a pick the configuration no longer holds as no pick", () => {
    hydrate(buildGoldenMokaFile());
    useModelStore.setState({ view: configured() });
    useAssistantStore.setState({ model: "a-model-taken-away" });
    render(<AssistantPanel />);

    expect(
      (screen.getByTestId("assistant-model") as HTMLSelectElement).value,
    ).toBe("");
  });
});

describe("before anything can be asked", () => {
  it("refuses a capability the board has no model for", () => {
    hydrate(buildGoldenMokaFile());
    useModelStore.setState({ view: bare() });
    render(<AssistantPanel />);

    expect(screen.getByRole("alert").textContent).toBe(
      "No text model is configured yet",
    );
    expect(screen.queryByLabelText("Ask about this canvas")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Configure models" }));
    expect(useModelStore.getState().open).toBe(true);
    // Straight to the category that has nothing configured.
    expect(useModelStore.getState().tab).toBe("text");
  });

  it("names the picture it cannot make rather than promising one", () => {
    hydrate(buildGoldenMokaFile());
    useModelStore.setState({ view: bare() });
    render(<AssistantPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Image" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "No image model is configured yet",
    );
  });
});
