import { describe, expect, it } from "vitest";
import {
  createPerformer,
  directorTransform,
  type DirectorObject,
} from "../../../shared/domain";
import { boneRotation, poseRotation, sampleBoneTrack } from "./poses";
import { autoBoneMap, normalizeBoneName, rigReady } from "./rig";

function actor(): DirectorObject {
  return createPerformer("standard", "Actor", "#e06c75", [0, 0, 0]);
}

describe("director poses", () => {
  it("turns the arms out for a T-pose and leaves other joints alone", () => {
    const left = poseRotation("t_pose", "leftUpperArm");
    const right = poseRotation("t_pose", "rightUpperArm");
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(left?.[2]).toBeLessThan(0);
    expect(right?.[2]).toBeGreaterThan(0);
    expect(poseRotation("t_pose", "head")).toBeUndefined();
  });

  it("keeps humanoid and quadruped pose sets apart", () => {
    expect(poseRotation("sit", "leftUpperLeg")).toBeDefined();
    expect(poseRotation("sit", "frontLeftUpperLeg")).toBeUndefined();
    expect(poseRotation("animal_lie", "frontLeftUpperLeg")).toBeDefined();
    expect(poseRotation("animal_lie", "head")).toBeDefined();
  });

  it("samples step, linear, and smooth easings as the plan states", () => {
    const track = {
      bone: "head" as const,
      keyframes: [
        {
          id: "a",
          time: 0,
          rotation: [0, 0, 0, 1] as [number, number, number, number],
        },
        {
          id: "b",
          time: 1,
          rotation: [0, 0.7071068, 0, 0.7071068] as [
            number,
            number,
            number,
            number,
          ],
        },
      ],
    };
    expect(sampleBoneTrack(track, -1)).toEqual([0, 0, 0, 1]);
    expect(sampleBoneTrack(track, 2)?.[1]).toBeCloseTo(0.7071068, 6);
    const linear = sampleBoneTrack(track, 0.5)?.[1] ?? 0;
    expect(linear).toBeCloseTo(Math.sin(Math.PI / 8), 6);
    const stepped = sampleBoneTrack(
      {
        ...track,
        keyframes: [
          { ...track.keyframes[0], easing: "step" as const },
          track.keyframes[1],
        ],
      },
      0.5,
    );
    expect(stepped?.[1]).toBeCloseTo(0, 6);
    const smooth = sampleBoneTrack(
      {
        ...track,
        keyframes: [
          { ...track.keyframes[0], easing: "smooth" as const },
          track.keyframes[1],
        ],
      },
      0.5,
    );
    // smin(0.5) is 0.5, so the smooth value equals the linear one at the
    // midpoint; a quarter in tells the two apart.
    const quarter = sampleBoneTrack(
      {
        ...track,
        keyframes: [
          { ...track.keyframes[0], easing: "smooth" as const },
          track.keyframes[1],
        ],
      },
      0.25,
    );
    expect(quarter?.[1]).toBeLessThan(sampleBoneTrack(track, 0.25)?.[1] ?? 0);
    expect(smooth?.[1]).toBeCloseTo(linear, 6);
  });

  it("reads keyframes before overrides before pose", () => {
    const object = actor();
    object.pose = "wave";
    object.boneOverrides = { rightUpperArm: [0, 0, 0, 1] };
    expect(boneRotation(object, "rightUpperArm", 0)).toEqual([0, 0, 0, 1]);
    object.boneTracks = [
      {
        bone: "rightUpperArm",
        keyframes: [{ id: "k", time: 0, rotation: [0, 0.5, 0, 0.8660254] }],
      },
    ];
    expect(boneRotation(object, "rightUpperArm", 0)).toEqual([
      0, 0.5, 0, 0.8660254,
    ]);
    expect(boneRotation(object, "head", 0)).toBeDefined();
  });
});

describe("rig mapping", () => {
  it("normalizes decorated names", () => {
    expect(normalizeBoneName("mixamorig:LeftUpLeg")).toBe("mixamorigleftupleg");
  });

  it("finds the common humanoid joints in a Mixamo-style rig", () => {
    const bones = [
      "mixamorigHips",
      "mixamorigSpine",
      "mixamorigSpine1",
      "mixamorigSpine2",
      "mixamorigNeck",
      "mixamorigHead",
      "mixamorigLeftArm",
      "mixamorigLeftForeArm",
      "mixamorigLeftHand",
      "mixamorigRightArm",
      "mixamorigRightForeArm",
      "mixamorigRightHand",
      "mixamorigLeftUpLeg",
      "mixamorigLeftLeg",
      "mixamorigLeftFoot",
      "mixamorigRightUpLeg",
      "mixamorigRightLeg",
      "mixamorigRightFoot",
    ];
    const map = autoBoneMap(bones);
    expect(rigReady(map)).toBe(true);
    expect(map.hips).toBe("mixamorigHips");
    expect(map.leftUpperArm).toBe("mixamorigLeftArm");
    expect(map.rightFoot).toBe("mixamorigRightFoot");
    expect(Object.keys(map).length).toBeGreaterThanOrEqual(8);
  });

  it("does not claim one model bone for two joints", () => {
    const map = autoBoneMap(["hips"]);
    expect(map.hips).toBe("hips");
    expect(Object.values(map).filter((name) => name === "hips")).toHaveLength(
      1,
    );
  });

  it("calls a short mapping unmapped", () => {
    expect(rigReady(autoBoneMap(["hips", "head"]))).toBe(false);
  });
});

describe("director transforms", () => {
  it("keeps a performer on the ground when the group is scaled", () => {
    const object = actor();
    object.transform = {
      ...directorTransform([1, 0, 2]),
      scale: [1, 1.1, 1],
    };
    expect(object.transform.position[1]).toBe(0);
    expect(object.actorBuild?.stature).toBe(1.68);
  });
});
