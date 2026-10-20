import { describe, expect, it } from "vitest";
import {
  canRecordCanvas,
  canRender3d,
  lowTextureBudget,
  type DirectorCapabilities,
} from "./capabilities";

function capabilities(
  overrides: Partial<DirectorCapabilities> = {},
): DirectorCapabilities {
  return {
    webgl2: true,
    webgl: false,
    maxTextureSize: 8192,
    mediaRecorder: true,
    recordingMimeTypes: ["video/webm;codecs=vp9"],
    reduceMotion: false,
    ...overrides,
  };
}

describe("director capabilities", () => {
  it("accepts either WebGL 2 or WebGL 1 as drawable", () => {
    expect(canRender3d(capabilities())).toBe(true);
    expect(canRender3d(capabilities({ webgl2: false, webgl: true }))).toBe(
      true,
    );
    expect(canRender3d(capabilities({ webgl2: false, webgl: false }))).toBe(
      false,
    );
  });

  it("records only when the recorder and a canvas stream both exist", () => {
    expect(canRecordCanvas(capabilities())).toBe(true);
    expect(canRecordCanvas(capabilities({ mediaRecorder: false }))).toBe(false);
    expect(canRecordCanvas(capabilities({ recordingMimeTypes: [] }))).toBe(
      false,
    );
  });

  it("warns below 4096 texels without blocking the room", () => {
    expect(lowTextureBudget(capabilities({ maxTextureSize: 2048 }))).toBe(true);
    expect(lowTextureBudget(capabilities({ maxTextureSize: 4096 }))).toBe(
      false,
    );
    expect(
      lowTextureBudget(
        capabilities({ webgl2: false, webgl: false, maxTextureSize: 0 }),
      ),
    ).toBe(false);
  });
});
