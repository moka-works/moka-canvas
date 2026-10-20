import { describe, expect, it } from "vitest";
import {
  aspectValue,
  cameraUsable,
  fitAspectRect,
  horizontalFov,
  orthographicHalfRanges,
  outputSize,
  stageBounds,
  verticalFov,
} from "./framing";
import {
  createDirectorScene,
  createPerformer,
  defaultDirectorCamera,
  directorTransform,
} from "../../../shared/domain";

describe("director framing", () => {
  it("derives the same lens view for every frame shape", () => {
    const wide = verticalFov(50, 16 / 9);
    const tall = verticalFov(50, 9 / 16);
    // The horizontal view is the lens's own and does not change with the
    // frame; the vertical view does.
    expect(Math.tan(wide / 2) * (16 / 9)).toBeCloseTo(
      Math.tan(horizontalFov(50) / 2),
      8,
    );
    expect(tall).toBeGreaterThan(wide);
  });

  it("reads a ratio and falls back for words it cannot read", () => {
    expect(aspectValue("16:9")).toBeCloseTo(16 / 9);
    expect(aspectValue("2.39:1")).toBeCloseTo(2.39);
    expect(aspectValue("nonsense")).toBeCloseTo(16 / 9);
  });

  it("keeps a shot's long edge at the stated pixel count", () => {
    expect(outputSize("16:9")).toEqual({ width: 1920, height: 1080 });
    expect(outputSize("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(outputSize("2.39:1")).toEqual({ width: 1920, height: 803 });
  });

  it("fits the shot shape inside a viewport and centres it", () => {
    const frame = fitAspectRect(1000, 1000, 16 / 9);
    expect(frame.width).toBe(1000);
    expect(frame.height).toBeCloseTo(562.5);
    expect(frame.y).toBeCloseTo((1000 - 562.5) / 2);
  });

  it("frames a flat, empty stage at a usable size", () => {
    const scene = createDirectorScene("Shot", "empty");
    const bounds = stageBounds(scene);
    expect(bounds.span[0]).toBeGreaterThanOrEqual(2);
    expect(bounds.span[1]).toBeGreaterThanOrEqual(2);
    expect(bounds.span[2]).toBeGreaterThanOrEqual(2);
  });

  it("grows an orthographic view to contain both spans", () => {
    const wide = orthographicHalfRanges(20, 2, 9 / 16);
    expect(wide.halfWidth).toBeGreaterThan(10);
    expect(wide.halfHeight).toBeGreaterThanOrEqual(
      wide.halfWidth / (9 / 16) - 1e-9,
    );
    const tall = orthographicHalfRanges(2, 20, 16 / 9);
    expect(tall.halfHeight).toBeGreaterThan(10);
    expect(tall.halfWidth).toBeGreaterThanOrEqual(
      tall.halfHeight * (16 / 9) - 1e-9,
    );
  });

  it("refuses a camera whose near and far planes cannot be handed to Three", () => {
    const camera = defaultDirectorCamera("Camera");
    expect(cameraUsable(camera)).toBe(true);
    camera.far = camera.near;
    expect(cameraUsable(camera)).toBe(false);
    camera.far = 400;
    camera.transform = directorTransform([10, 2, 0]);
    camera.target = [10, 2, 0];
    // Coincident position and target are drawn from a temporary target by
    // the viewport; they are not themselves a reason to refuse the camera.
    expect(cameraUsable(camera)).toBe(true);
    camera.focalLength = Number.NaN;
    expect(cameraUsable(camera)).toBe(false);
  });

  it("measures a performer into the scene bounds", () => {
    const scene = createDirectorScene("Shot", "empty");
    scene.objects.push(
      createPerformer("standard", "Actor", "#e06c75", [4, 0, 0]),
    );
    const bounds = stageBounds(scene);
    // The actor at x=4 widens the stage's own span even though the camera
    // and the rim light already reach further out.
    expect(bounds.span[0]).toBeGreaterThan(10);
  });
});
