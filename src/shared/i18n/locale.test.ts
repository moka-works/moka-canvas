import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveLocale, systemLocale } from ".";

/**
 * The path of every key an object writes twice.
 *
 * The catalogues are read as text on purpose: JSON.parse keeps the last of two
 * keys written at the same place and says nothing, so a section written twice
 * loses its earlier words and the interface shows their raw keys instead.
 */
function duplicateKeys(text: string): string[] {
  const found: string[] = [];
  const frames: {
    name: string;
    object: boolean;
    keys: Set<string>;
    pending: string | null;
    items: number;
  }[] = [];
  let at = 0;
  let expectingKey = false;
  while (at < text.length) {
    const ch = text[at];
    if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") {
      at += 1;
      continue;
    }
    const frame = frames[frames.length - 1];
    if (ch === "{" || ch === "[") {
      const name =
        frame === undefined
          ? ""
          : frame.object
            ? (frame.pending ?? "")
            : String(frame.items++);
      if (frame !== undefined) frame.pending = null;
      frames.push({
        name,
        object: ch === "{",
        keys: new Set(),
        pending: null,
        items: 0,
      });
      expectingKey = ch === "{";
      at += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      frames.pop();
      expectingKey = false;
      at += 1;
      continue;
    }
    if (ch === ",") {
      if (frame !== undefined) expectingKey = frame.object;
      at += 1;
      continue;
    }
    if (ch === ":") {
      expectingKey = false;
      at += 1;
      continue;
    }
    if (ch === '"') {
      let end = at + 1;
      let value = "";
      while (end < text.length && text[end] !== '"') {
        if (text[end] === "\\") {
          value += text[end + 1];
          end += 2;
        } else {
          value += text[end];
          end += 1;
        }
      }
      at = end + 1;
      if (frame?.object === true && expectingKey) {
        if (frame.keys.has(value)) {
          found.push(
            [...frames.map((held) => held.name).filter(Boolean), value].join(
              ".",
            ),
          );
        }
        frame.keys.add(value);
        frame.pending = value;
        expectingKey = false;
      }
      continue;
    }
    at += 1;
  }
  return found;
}

describe("duplicateKeys", () => {
  it("names a section written twice", () => {
    expect(duplicateKeys('{"a": {"b": 1}, "a": {"c": 2}}')).toEqual(["a"]);
  });

  it("says nothing about two objects holding the same key apart", () => {
    expect(duplicateKeys('{"a": {"b": 1}, "c": {"b": 2}}')).toEqual([]);
  });
});

describe("locale catalogues", () => {
  it("write every key once", () => {
    const root = new URL("./locales/", import.meta.url);
    for (const locale of ["en", "zh"]) {
      const folder = new URL(`${locale}/`, root);
      for (const file of readdirSync(folder)) {
        const text = readFileSync(new URL(file, folder), "utf8");
        expect(duplicateKeys(text), `${locale}/${file}`).toEqual([]);
      }
    }
  });
});

describe("systemLocale", () => {
  it("maps every Chinese tag to Chinese", () => {
    expect(systemLocale("zh")).toBe("zh");
    expect(systemLocale("zh-CN")).toBe("zh");
    expect(systemLocale("zh-Hant-TW")).toBe("zh");
  });

  it("maps everything else, including nothing, to English", () => {
    expect(systemLocale("en-US")).toBe("en");
    expect(systemLocale("de")).toBe("en");
    expect(systemLocale("")).toBe("en");
  });
});

describe("resolveLocale", () => {
  it("follows the machine only in system mode", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("zh")).toBe("zh");
    expect(resolveLocale("system")).toBe(systemLocale());
  });
});
