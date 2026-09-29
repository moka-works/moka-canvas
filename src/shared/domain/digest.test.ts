import { describe, expect, it } from "vitest";

import { fnv1a } from "./digest";

describe("fnv1a", () => {
  it("reads the same words the same way, whoever asks", () => {
    // The published vectors, so a change to the arithmetic is caught rather
    // than quietly changing every digest a document already carries.
    expect(fnv1a("")).toBe("811c9dc5");
    expect(fnv1a("a")).toBe("e40c292c");
    expect(fnv1a("foobar")).toBe("bf9cf968");
    expect(fnv1a("雨夜列车")).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a("雨夜列车")).toBe(fnv1a("雨夜列车"));
  });

  it("moves when the words do, and stays inside its own shape", () => {
    expect(fnv1a("moka")).not.toBe(fnv1a("mokb"));
    expect(fnv1a("line:1")).not.toBe(fnv1a("line:2"));
    expect(fnv1a("Rain at Night · the film")).toMatch(/^[0-9a-f]{8}$/);
  });
});
