import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { elementPlaceholderUrl } from "./elementPlaceholder";

describe("element placeholders", () => {
  it("gives each kind its own picture, and every picture is on disk", () => {
    const urls = (["character", "scene", "prop"] as const).map(
      elementPlaceholderUrl,
    );
    expect(new Set(urls).size).toBe(3);
    for (const url of urls) {
      expect(url.endsWith(".svg")).toBe(true);
      expect(existsSync(resolve(process.cwd(), "public", url.slice(1)))).toBe(
        true,
      );
    }
  });
});
