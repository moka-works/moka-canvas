import { describe, expect, it } from "vitest";

import { findQuote, sourceHeadings, windowEndAt } from "./storySource";

describe("counting the chapters a manuscript writes", () => {
  it("says how many headings it has, and none when they are too few to be one", () => {
    expect(
      sourceHeadings("第一章 站台\n他等着。\n第二章 车厢\n车厢很暗。"),
    ).toBe(2);
    expect(sourceHeadings("第1章\n第二章\nChapter 3\n3、第四段")).toBe(4);
    expect(sourceHeadings("第 1 章 站台\n第 2 集 车厢")).toBe(2);
    // One heading is a line that happened to start with a number.
    expect(sourceHeadings("第一章 站台\n他等着。")).toBe(0);
    expect(sourceHeadings("他等着，没有章节标题。")).toBe(0);
  });
});

describe("reading a manuscript in windows", () => {
  it("cuts a window back to the last paragraph break it can take", () => {
    const text = `${"甲".repeat(60)}\n\n${"乙".repeat(60)}\n\n${"丙".repeat(60)}`;
    // A budget of 130 lands inside the second paragraph; the break before it
    // is the last one worth taking.
    expect(windowEndAt(text, 0, 130)).toBe(124);
  });

  it("takes a line break when there is no paragraph break in reach", () => {
    const text = `${"甲".repeat(60)}\n${"乙".repeat(60)}\n${"丙".repeat(60)}`;
    expect(windowEndAt(text, 0, 130)).toBe(122);
  });

  it("does not halve the window to find a break", () => {
    const text = `${"甲".repeat(60)}\n\n${"乙".repeat(100)}`;
    // The paragraph break is before the middle of the window: it is still
    // better than cutting the second paragraph in half.
    expect(windowEndAt(text, 0, 100)).toBe(62);
  });

  it("ends at the text's end rather than looking past it", () => {
    expect(windowEndAt("短稿", 0, 500_000)).toBe(2);
    expect(windowEndAt("短稿", 3, 500_000)).toBe(2);
  });
});

describe("finding a quotation in the manuscript", () => {
  const window =
    "第一章 站台\n他在站台上等车。\n第二章 车厢\n车厢里只有两个人。";

  it("finds the words exactly where they were copied", () => {
    expect(findQuote(window, "第二章 车厢", 0)).toBe(16);
    // A quotation is searched for after the last boundary, so an earlier
    // repetition belongs to the chapter already placed.
    expect(findQuote(window, "他在站台上等车。", 5)).toBe(7);
    expect(findQuote(window, "他在站台上等车。", 10)).toBeUndefined();
  });

  it("does not care about a reflowed line or decorative punctuation", () => {
    expect(findQuote(window, "“第二章\n车厢”", 0)).toBe(16);
  });

  it("says nothing when the quotation was paraphrased", () => {
    expect(findQuote(window, "第二章 列车", 0)).toBeUndefined();
  });
});
