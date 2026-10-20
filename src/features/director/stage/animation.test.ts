import { describe, expect, it } from "vitest";
import {
  createDirectorScene,
  createPerformer,
  directorTransform,
  type DirectorObject,
} from "../../../shared/domain";
import {
  applyBoneRotation,
  applyObjectTransform,
  cameraMoveEnd,
  cameraMoveKeyframes,
  mergeKeyframes,
  pathKeyframes,
  recordKeyframe,
  sampleTransform,
  simplifyPath,
  snapTime,
  upsertTransformKeyframe,
} from "./animation";

function actor(): DirectorObject {
  return createPerformer("standard", "Actor", "#e06c75", [0, 0, 0]);
}

const at = (x: number, y = 0, z = 0) => directorTransform([x, y, z]);

describe("director transform animation", () => {
  it("snaps to the nearest frame", () => {
    expect(snapTime(1.016, 30)).toBeCloseTo(1, 5);
    expect(snapTime(1.02, 30)).toBeCloseTo(1.0333333, 5);
  });

  it("reads steps, lines, and smooth movement", () => {
    const frames = [
      { id: "a", time: 0, transform: at(0) },
      { id: "b", time: 1, transform: at(10), easing: "smooth" as const },
    ];
    expect(sampleTransform(frames, 0.5)?.position[0]).toBeCloseTo(5);
    const stepped = [
      { id: "a", time: 0, transform: at(0), easing: "step" as const },
      { id: "b", time: 1, transform: at(10) },
    ];
    expect(sampleTransform(stepped, 0.999)?.position[0]).toBe(0);
    const smoothQuarter = sampleTransform(
      [{ ...frames[0], easing: "smooth" as const }, frames[1]],
      0.25,
    )?.position[0];
    expect(smoothQuarter).toBeCloseTo(1.5625, 4);
    expect(sampleTransform([], 0)).toBeUndefined();
    expect(sampleTransform([frames[0]], 10)?.position[0]).toBe(0);
  });

  it("overwrites a keyframe at the same instant instead of stacking", () => {
    let frames = upsertTransformKeyframe([], 0, at(0));
    frames = upsertTransformKeyframe(frames, 0.0005, at(4));
    expect(frames).toHaveLength(1);
    expect(frames[0].transform.position[0]).toBe(4);
  });

  it("records a keyframe at the snapped time with AutoKey on", () => {
    const scene = createDirectorScene("Shot");
    const object = actor();
    scene.objects.push(object);
    const next = applyObjectTransform(
      scene,
      object.id,
      { ...object.transform, position: [2, 0, 0] },
      true,
      1.02,
      30,
    );
    expect(next.objects[0].transform.position[0]).toBe(0);
    expect(next.objects[0].keyframes).toHaveLength(1);
    expect(next.objects[0].keyframes[0].time).toBeCloseTo(31 / 30, 5);
  });

  it("moves the whole animation when AutoKey is off on a keyed object", () => {
    const scene = createDirectorScene("Shot");
    const object = actor();
    object.keyframes = [
      { id: "a", time: 0, transform: at(0) },
      { id: "b", time: 1, transform: at(2) },
    ];
    scene.objects.push(object);
    const next = applyObjectTransform(
      scene,
      object.id,
      { ...object.transform, position: [5, 0, 0] },
      false,
      0,
      30,
    );
    expect(next.objects[0].transform.position[0]).toBe(5);
    expect(next.objects[0].keyframes[0].transform.position[0]).toBe(5);
    expect(next.objects[0].keyframes[1].transform.position[0]).toBe(7);
  });

  it("keeps a bone override and writes its keyframe under AutoKey", () => {
    const scene = createDirectorScene("Shot");
    const object = actor();
    scene.objects.push(object);
    const rotation: [number, number, number, number] = [0, 0.5, 0, 0.866];
    const withOverride = applyBoneRotation(
      scene,
      object.id,
      "head",
      rotation,
      false,
      0,
      30,
    );
    expect(withOverride.objects[0].boneTracks).toBeUndefined();
    expect(withOverride.objects[0].boneOverrides?.head).toEqual(rotation);
    const withKey = applyBoneRotation(
      withOverride,
      object.id,
      "head",
      rotation,
      true,
      0.5,
      30,
    );
    expect(withKey.objects[0].boneTracks?.[0].keyframes).toHaveLength(1);
    expect(withKey.objects[0].boneTracks?.[0].keyframes[0].time).toBe(0.5);
  });
});

describe("director camera moves", () => {
  it("moves a push-in closer and keeps the target put", () => {
    const scene = createDirectorScene("Shot");
    const camera = scene.cameras[0];
    const end = cameraMoveEnd(camera, "push_in");
    expect(end).not.toBeNull();
    const before = Math.hypot(
      camera.target[0] - camera.transform.position[0],
      camera.target[1] - camera.transform.position[1],
      camera.target[2] - camera.transform.position[2],
    );
    const after = Math.hypot(
      camera.target[0] - end!.position[0],
      camera.target[1] - end!.position[1],
      camera.target[2] - end!.position[2],
    );
    expect(after).toBeLessThan(before);
  });

  it("writes the ends and leaves the middle alone", () => {
    const scene = createDirectorScene("Shot");
    const camera = { ...scene.cameras[0] };
    camera.keyframes = [{ id: "middle", time: 2, transform: at(1) }];
    const frames = cameraMoveKeyframes(camera, "pan_left", 6);
    expect(frames.some((frame) => frame.id === "middle")).toBe(true);
    expect(frames.some((frame) => Math.abs(frame.time) < 1e-6)).toBe(true);
    expect(frames.some((frame) => Math.abs(frame.time - 6) < 1e-6)).toBe(true);
  });

  it("records the value at the playhead at the snapped frame", () => {
    const scene = createDirectorScene("Shot");
    const object = actor();
    object.keyframes = [
      { id: "a", time: 0, transform: at(0) },
      { id: "b", time: 1, transform: at(4) },
    ];
    scene.objects.push(object);
    const next = recordKeyframe(
      scene,
      { kind: "object", id: object.id },
      0.5,
      30,
    );
    expect(next.objects[0].keyframes).toHaveLength(3);
    expect(
      next.objects[0].keyframes.find(
        (frame) => frame.id !== "a" && frame.id !== "b",
      )?.transform.position[0],
    ).toBeCloseTo(2);
  });
});

describe("director paths", () => {
  it("simplifies a straight line to its ends", () => {
    const points = [
      { x: 0, z: 0 },
      { x: 1, z: 0 },
      { x: 2, z: 0 },
      { x: 3, z: 0 },
    ];
    expect(simplifyPath(points, 0.025)).toEqual([
      { x: 0, z: 0 },
      { x: 3, z: 0 },
    ]);
  });

  it("times keyframes by distance and faces the way it walks", () => {
    const frames = pathKeyframes(
      [
        { x: 0, z: 0 },
        { x: 3, z: 0 },
      ],
      0,
      6,
      at(0, 0, 0),
      true,
    );
    expect(frames).toHaveLength(2);
    expect(frames[0].time).toBe(0);
    expect(frames[1].time).toBe(6);
    expect(frames[1].transform.position[0]).toBe(3);
    expect(frames[1].transform.rotation[1]).toBeCloseTo(Math.PI / 2, 5);
    expect(frames[0].easing).toBe("smooth");
  });

  it("keeps frames from a path joined to an existing animation", () => {
    const base = [{ id: "old", time: 0, transform: at(99) }];
    const generated = pathKeyframes(
      [
        { x: 1, z: 1 },
        { x: 2, z: 2 },
      ],
      0,
      2,
      at(0),
      false,
    );
    const merged = mergeKeyframes(base, generated);
    expect(merged).toHaveLength(2);
    expect(merged[0].transform.position[0]).toBe(1);
    // The frame at the same instant keeps its id and takes the new value.
  });
});
