import { describe, expect, it } from "vitest";

import { chapterStripWindow } from "./chapterStrip";

describe("chapterStripWindow", () => {
  it("windows a long strip to three episodes and the gaps beyond", () => {
    // Two apart in the middle: the episodes either side, with a gap standing
    // for what is hidden on both hands.
    expect(chapterStripWindow(6, 3)).toEqual(["gap", 2, 3, 4, "gap"]);
    // On the first and last episodes the window runs one way, so stepping
    // onward never needs the strip opened.
    expect(chapterStripWindow(6, 0)).toEqual([0, 1, 2, "gap"]);
    expect(chapterStripWindow(6, 5)).toEqual(["gap", 3, 4, 5]);
    expect(chapterStripWindow(5, 1)).toEqual([0, 1, 2, "gap"]);
    expect(chapterStripWindow(5, 3)).toEqual(["gap", 2, 3, 4]);
  });

  it("shows a strip short enough to fit whole", () => {
    expect(chapterStripWindow(3, 1)).toEqual([0, 1, 2]);
    expect(chapterStripWindow(2, 0)).toEqual([0, 1]);
  });
});
