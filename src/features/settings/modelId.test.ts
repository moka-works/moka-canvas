import { describe, expect, it } from "vitest";
import { MAX_MODEL_ID_LENGTH } from "../../shared/domain";
import {
  identifierStem,
  identifierSuffix,
  suggestedModelId,
  uniqueModelId,
} from "./modelId";

describe("identifierStem", () => {
  it("lowercases a plain name", () => {
    expect(identifierStem("Writer")).toBe("writer");
  });

  it("turns the spaces and symbols between words into single hyphens", () => {
    expect(identifierStem("GPT-4o mini (OpenAI)")).toBe("gpt-4o-mini-openai");
  });

  it("keeps a hyphen, which is how the identifiers already stored are written", () => {
    expect(identifierStem("gpt-4o-mini")).toBe("gpt-4o-mini");
  });

  it("collapses the separators a dropped symbol leaves behind", () => {
    expect(identifierStem("Writer - the best")).toBe("writer-the-best");
  });

  it("carries no separator in or out", () => {
    expect(identifierStem("  _Painter_  ")).toBe("painter");
  });

  it("leaves nothing of a name made only of symbols", () => {
    expect(identifierStem("!!!")).toBe("");
    expect(identifierStem("")).toBe("");
  });

  it("stays inside the ceiling the server enforces, tail included", () => {
    const stem = identifierStem("a".repeat(400));
    expect(stem.length).toBe(MAX_MODEL_ID_LENGTH - 7);
  });
});

describe("suggestedModelId", () => {
  it("joins the stem to a random tail", () => {
    expect(suggestedModelId("Composer")).toMatch(/^composer-[a-z0-9]{6}$/);
  });

  it("still names a model when the name has nothing readable in it", () => {
    expect(suggestedModelId("!!!")).toMatch(/^model-[a-z0-9]{6}$/);
    expect(suggestedModelId("")).toMatch(/^model-[a-z0-9]{6}$/);
  });

  it("never goes over the ceiling", () => {
    expect(suggestedModelId("a".repeat(400)).length).toBeLessThanOrEqual(
      MAX_MODEL_ID_LENGTH,
    );
  });

  it("differs from the last one, which is what keeps two Writers apart", () => {
    expect(suggestedModelId("Writer")).not.toBe(suggestedModelId("Writer"));
  });

  it("is a shape the server accepts: no whitespace, no legacy separator", () => {
    const id = suggestedModelId("My Writer :: the best");
    expect(id).not.toMatch(/\s/);
    expect(id).not.toContain("::");
  });
});

describe("identifierSuffix", () => {
  it("is six lowercase letters and digits", () => {
    expect(identifierSuffix()).toMatch(/^[a-z0-9]{6}$/);
  });
});

describe("uniqueModelId", () => {
  it("suggests the readable identifier when nothing holds it", () => {
    expect(uniqueModelId("Composer", () => false)).toMatch(
      /^composer-[a-z0-9]{6}$/,
    );
  });

  it("draws again rather than offering an identifier that is taken", () => {
    const taken = new Set<string>();
    const id = uniqueModelId("Writer", (candidate) => {
      // The first two draws are refused, so what comes back is the third.
      if (taken.size < 2) {
        taken.add(candidate);
        return true;
      }
      return false;
    });
    expect(id).toMatch(/^writer-[a-z0-9]{6}$/);
    if (id === null) throw new Error("a free identifier was expected");
    expect(taken.has(id)).toBe(false);
  });

  it("gives up on an identifier somebody else holds, so nothing is saved over them", () => {
    expect(uniqueModelId("Writer", () => true, 3)).toBeNull();
  });
});
