import { describe, expect, it } from "vitest";
import {
  DIMMED_OPACITY,
  RUNNING_DIMMED_OPACITY,
  dimOpacity,
  relatedDimmed,
} from "./emphasis";

const related = new Set(["a", "b"]);
const run = (status: "queued" | "running" | "succeeded" | "failed") => ({
  status,
  progress: null,
  error: null,
  said: "",
});

describe("the related highlight's dimming", () => {
  it("leaves a card alone while no chain is lit", () => {
    expect(relatedDimmed(null, "c")).toBe(false);
  });

  it("leaves the chain itself alone", () => {
    expect(relatedDimmed(related, "a")).toBe(false);
  });

  it("draws back a card outside the chain, running or not", () => {
    expect(relatedDimmed(related, "c")).toBe(true);
  });
});

describe("how far a card outside the chain is drawn back", () => {
  it("stands a card with nothing going on well back", () => {
    expect(dimOpacity(null)).toBe(DIMMED_OPACITY);
    expect(dimOpacity(run("succeeded"))).toBe(DIMMED_OPACITY);
    expect(dimOpacity(run("failed"))).toBe(DIMMED_OPACITY);
  });

  it("draws back a card being worked on, but not out of sight", () => {
    for (const status of ["queued", "running"] as const) {
      expect(dimOpacity(run(status))).toBe(RUNNING_DIMMED_OPACITY);
      expect(RUNNING_DIMMED_OPACITY).toBeGreaterThan(DIMMED_OPACITY);
    }
  });
});
