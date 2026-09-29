import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client";
import type { AssistantSession, CanvasDocument } from "../../shared/domain";
import { emptyCanvas, MAX_ASSISTANT_TITLE_LENGTH } from "../../shared/domain";
import {
  latestSession,
  lineAsked,
  lineCutShort,
  lineFailed,
  lineFromRun,
  lineSaid,
  sessionShown,
  sessionTarget,
  titleFor,
} from "./conversation";

const T = "2026-01-01T00:00:00.000Z";

function talk(id: string, title: string, updatedAt: string): AssistantSession {
  return { id, title, messages: [], createdAt: T, updatedAt };
}

/** A canvas holding these conversations and nothing else. */
function board(sessions: readonly AssistantSession[]): CanvasDocument {
  return { ...emptyCanvas("c-1", "One"), sessions: [...sessions] };
}

/** Two conversations, one of which something was said in later than the other. */
const TALKED = [
  talk("s-old", "Older", T),
  talk("s-new", "Newer", "2026-02-02T00:00:00.000Z"),
];

describe("latestSession", () => {
  it("has nothing to carry on with when nothing has been said", () => {
    expect(latestSession([])).toBeNull();
  });

  it("finds the one something was last said in, wherever it sits", () => {
    // Put back by an undo, which lands it last in a list that means nothing by
    // place: what is read is when, not where.
    const held = [
      talk("s-new", "Newer", "2026-02-02T00:00:00.000Z"),
      talk("s-old", "Older", "2026-01-01T00:00:00.000Z"),
      talk("s-last", "Last", "2026-03-03T00:00:00.000Z"),
    ];
    expect(latestSession(held)?.id).toBe("s-last");
  });
});

describe("the conversation on show", () => {
  it("goes to the one something was last said in", () => {
    expect(sessionShown(board(TALKED), "newest")?.id).toBe("s-new");
  });

  it("keeps reading the one that was picked, wherever it sits", () => {
    expect(sessionShown(board(TALKED), "s-old")?.id).toBe("s-old");
  });

  it("reads as the newest again once the picked one has been taken away", () => {
    // The reader did not ask to stop seeing conversations, only to stop seeing
    // that one, so the panel is not left looking at nothing.
    expect(sessionShown(board([TALKED[1]]), "s-old")?.id).toBe("s-new");
  });

  it("has nothing to show for a conversation nothing has been said in", () => {
    expect(sessionShown(board(TALKED), "fresh")).toBeNull();
  });

  it("has nothing to show on a canvas that has never been talked over", () => {
    expect(sessionShown(board([]), "newest")).toBeNull();
  });
});

describe("the conversation a turn is written to", () => {
  it("carries on the conversation the panel is reading", () => {
    const target = sessionTarget(board(TALKED), "s-old");
    expect(target).toEqual({ id: "s-old", opening: false });
  });

  it("opens one when the panel is reading a fresh conversation", () => {
    const opening = sessionTarget(board(TALKED), "fresh");
    expect(opening.opening).toBe(true);
    expect(TALKED.some((session) => session.id === opening.id)).toBe(false);
  });

  it("opens one on a canvas that has never been talked over", () => {
    expect(sessionTarget(board([]), "newest").opening).toBe(true);
  });
});

describe("titleFor", () => {
  it("names a conversation after what was first asked of it", () => {
    expect(titleFor("  what   is this  ")).toBe("what is this");
  });

  it("cuts a first sentence too long to be read in a list of them", () => {
    const named = titleFor("a".repeat(400));
    expect(named.endsWith("…")).toBe(true);
    expect(named.length).toBeLessThanOrEqual(MAX_ASSISTANT_TITLE_LENGTH);
  });
});

describe("the lines a turn is kept as", () => {
  it("records a question as the reader's, carrying what it was about", () => {
    const line = lineAsked(
      "what is [Plate] doing",
      [{ nodeId: "n-plate", title: "Plate", kind: "image" }],
      T,
    );
    expect(line.role).toBe("user");
    expect(line.text).toBe("what is [Plate] doing");
    expect(line.createdAt).toBe(T);
    expect(line.references).toEqual([
      { nodeId: "n-plate", title: "Plate", kind: "image" },
    ]);
  });

  it("carries no references when a question was about none", () => {
    expect(lineAsked("anything", [], T).references).toBeUndefined();
  });

  it("records an answer as the model's", () => {
    const line = lineSaid("It floats.", T);
    expect(line.role).toBe("assistant");
    expect(line.text).toBe("It floats.");
    expect(line.failure).toBeUndefined();
  });

  it("gives every line its own name", () => {
    expect(lineSaid("One", T).id).not.toBe(lineSaid("One", T).id);
  });
});

describe("lineFailed", () => {
  it("keeps a provider's own word for what went wrong", () => {
    const line = lineFailed(
      new ApiError({
        code: "PROVIDER_RATE_LIMIT",
        message: "Too many asks at once.",
        status: 429,
        details: { retryable: true },
      }),
      T,
    );
    expect(line.role).toBe("error");
    expect(line.text).toBe("Too many asks at once.");
    expect(line.failure).toEqual({
      code: "PROVIDER_RATE_LIMIT",
      retryable: true,
    });
  });

  it("says nothing is known to be transient unless the failure said so", () => {
    const line = lineFailed(
      new ApiError({
        code: "PROVIDER_BAD_REQUEST",
        message: "No.",
        status: 400,
      }),
      T,
    );
    expect(line.failure).toEqual({
      code: "PROVIDER_BAD_REQUEST",
      retryable: false,
    });
  });

  it("uses the nearest word the document has for a trouble it has no word for", () => {
    // A stream that never opened, or a body that could not be read: neither is
    // in the list of troubles, and a line saying so in a word the document does
    // not have would not be readable back.
    const line = lineFailed(
      ApiError.transport("Cannot reach the local process"),
      T,
    );
    expect(line.failure?.code).toBe("PROVIDER_UNAVAILABLE");
    expect(line.text).toBe("Cannot reach the local process");
  });

  it("says that nothing arrived when the trouble said nothing itself", () => {
    expect(lineFailed(new Error(""), T).text).toBe("The answer did not arrive");
    expect(lineFailed("not even an error", T).failure?.code).toBe(
      "PROVIDER_UNAVAILABLE",
    );
  });
});

describe("lineCutShort", () => {
  it("keeps what had arrived as an answer rather than throwing it away", () => {
    const line = lineCutShort("It floats over", T);
    expect(line.role).toBe("assistant");
    expect(line.text).toBe("It floats over");
    expect(line.failure).toBeUndefined();
  });

  it("records a turn stopped before anything came as one to ask again", () => {
    const line = lineCutShort("   ", T);
    expect(line.role).toBe("error");
    expect(line.failure).toEqual({
      code: "GENERATION_CANCELLED",
      retryable: true,
    });
  });
});

describe("lineFromRun", () => {
  it("names the run an answer came from, and the card it was for", () => {
    const line = lineFromRun({
      summary: "Made 2 images",
      runId: "r-1",
      nodeId: "n-card",
      at: T,
    });
    expect(line.role).toBe("assistant");
    expect(line.text).toBe("Made 2 images");
    expect(line.toolCalls).toEqual([
      { runId: "r-1", nodeId: "n-card", summary: "Made 2 images" },
    ]);
  });

  it("keeps a run that did not finish as one to ask again from", () => {
    // The card is already on the canvas and the record already holds what was
    // asked of it, so a line that said only that nothing arrived would lose both
    // of the ways back to the ask.
    const line = lineFromRun({
      summary: "Made nothing",
      runId: "r-1",
      nodeId: "n-card",
      at: T,
      failure: {
        message: "The model would not take the ask.",
        code: "PROVIDER_UNAVAILABLE",
        retryable: true,
      },
    });
    expect(line.role).toBe("error");
    expect(line.text).toBe("The model would not take the ask.");
    expect(line.failure).toEqual({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    expect(line.toolCalls).toEqual([
      { runId: "r-1", nodeId: "n-card", summary: "Made nothing" },
    ]);
  });
});
