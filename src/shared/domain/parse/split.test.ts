import { describe, expect, it } from "vitest";

import { parseSplitAnswer } from "./split";

describe("reading a split answer", () => {
  it("reads the number, title and quotations of every boundary", () => {
    const read = parseSplitAnswer(
      JSON.stringify({
        chapters: [
          {
            number: 1,
            title: "第一章 站台",
            start: "第一章 站台",
            end: "第二章 车厢",
          },
          {
            number: 2,
            title: "第二章 车厢",
            start: "第二章 车厢",
            end: "第三章 天亮",
            before: "车没有来。",
          },
        ],
      }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.pointers).toHaveLength(2);
    expect(read.value.pointers[0]).toMatchObject({
      number: 1,
      title: "第一章 站台",
      start: "第一章 站台",
      end: "第二章 车厢",
      discard: false,
    });
    expect(read.value.pointers[1]?.end).toBe("第三章 天亮");
    expect(read.value.pointers[1]?.before).toBe("车没有来。");
  });

  it("lets a chapter's end be left for the next part to place", () => {
    const read = parseSplitAnswer(
      JSON.stringify({
        chapters: [
          { number: 1, title: "第一章", start: "第一章", end: "第二章" },
          { number: 2, title: "第二章", start: "第二章" },
        ],
      }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.pointers[1]?.end).toBeUndefined();
    expect(read.value.pointers[1]?.start).toBe("第二章");
  });

  it("reads a chapter zero as front matter to leave out", () => {
    const read = parseSplitAnswer(
      JSON.stringify({
        chapters: [
          { number: 0, title: "目录", start: "目录" },
          { number: 1, title: "第一章", start: "第一章" },
        ],
      }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.pointers[0]?.discard).toBe(true);
    expect(read.value.pointers[1]?.discard).toBe(false);
  });

  it("lets the first chapter stand on the part's own opening", () => {
    const read = parseSplitAnswer(
      JSON.stringify({ chapters: [{ title: "第一章" }] }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.pointers[0]).toMatchObject({
      title: "第一章",
      discard: false,
    });
    expect(read.value.pointers[0]?.start).toBeUndefined();
  });

  it("leaves out a later boundary that cited nothing, and says so", () => {
    const read = parseSplitAnswer(
      JSON.stringify({
        chapters: [
          { number: 1, title: "第一章" },
          { number: 2, title: "第二章" },
        ],
      }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.pointers).toHaveLength(1);
    expect(read.value.warnings.join()).toContain("quoted neither");
  });

  it("answers with a failure when there is no boundary at all", () => {
    const read = parseSplitAnswer("I am afraid I cannot help with that.");
    expect(read.ok).toBe(false);
  });

  it("reads a bare list as the list it means", () => {
    const read = parseSplitAnswer(
      JSON.stringify([{ number: 1, title: "第一章", start: "第一章" }]),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.pointers).toHaveLength(1);
  });
});
