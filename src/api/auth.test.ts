import { describe, expect, it } from "vitest";
import { safeNext } from "./auth";

/** Only a path on this origin is returned; anything else lands on "/". */
describe("safeNext", () => {
  it("returns to where the sign-in was asked from", () => {
    expect(safeNext("?next=%2Fstory%3Fid%3D1")).toBe("/story?id=1");
  });

  it("lands on the launcher when nothing was asked for", () => {
    expect(safeNext("")).toBe("/");
    expect(safeNext("?next=")).toBe("/");
  });

  it("refuses addresses that leave the application", () => {
    for (const next of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example/path",
      "javascript:alert(1)",
      "%2F%2Fevil.example",
    ]) {
      expect(safeNext(`?next=${next}`)).toBe("/");
    }
  });
});
