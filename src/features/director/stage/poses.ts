import { Euler, Quaternion } from "three";
import type {
  DirectorBone,
  DirectorBoneTrack,
  DirectorHumanoidBone,
  DirectorObject,
  DirectorPose,
  DirectorQuat,
} from "../../../shared/domain";

const DEG = Math.PI / 180;

/** A quaternion written from degrees, in the order the inspector shows them. */
function q(x: number, y: number, z: number): DirectorQuat {
  const quaternion = new Quaternion().setFromEuler(
    new Euler(x * DEG, y * DEG, z * DEG),
  );
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

const IDENTITY: DirectorQuat = [0, 0, 0, 1];

/**
 * The local rotation each humanoid pose adds to the rest skeleton.
 *
 * A pose names only the bones it moves; every other bone keeps its rest
 * rotation. The numbers are blockout approximations of the gesture, not a
 * captured performance: a reader can rotate any joint from here.
 */
export const HUMANOID_POSES: Record<
  Extract<
    DirectorPose,
    | "neutral"
    | "stand"
    | "t_pose"
    | "walk"
    | "run"
    | "sit"
    | "squat"
    | "kneel_single"
    | "kneel_double"
    | "hands_hips"
    | "lean"
    | "bow"
    | "think"
    | "fight"
    | "kick"
    | "throw"
    | "push"
    | "wave"
    | "reach"
    | "arms_crossed"
    | "phone"
  >,
  Partial<Record<DirectorHumanoidBone, DirectorQuat>>
> = {
  neutral: {},
  stand: { spine: q(0, 0, 0) },
  t_pose: {
    leftUpperArm: q(0, 0, -88),
    rightUpperArm: q(0, 0, 88),
    leftLowerArm: q(0, 0, 0),
    rightLowerArm: q(0, 0, 0),
  },
  walk: {
    leftUpperLeg: q(24, 0, 0),
    rightUpperLeg: q(-24, 0, 0),
    leftLowerLeg: q(-8, 0, 0),
    rightLowerLeg: q(-22, 0, 0),
    leftUpperArm: q(-20, 0, 0),
    rightUpperArm: q(20, 0, 0),
    spine: q(2, 0, 0),
  },
  run: {
    leftUpperLeg: q(46, 0, 0),
    rightUpperLeg: q(-46, 0, 0),
    leftLowerLeg: q(-58, 0, 0),
    rightLowerLeg: q(-24, 0, 0),
    leftUpperArm: q(-62, 0, 0),
    rightUpperArm: q(62, 0, 0),
    leftLowerArm: q(-52, 0, 0),
    rightLowerArm: q(-52, 0, 0),
    spine: q(8, 0, 0),
  },
  sit: {
    leftUpperLeg: q(-86, 0, 0),
    rightUpperLeg: q(-86, 0, 0),
    leftLowerLeg: q(84, 0, 0),
    rightLowerLeg: q(84, 0, 0),
    leftFoot: q(-8, 0, 0),
    rightFoot: q(-8, 0, 0),
    spine: q(-4, 0, 0),
  },
  squat: {
    leftUpperLeg: q(-96, 0, 0),
    rightUpperLeg: q(-96, 0, 0),
    leftLowerLeg: q(112, 0, 0),
    rightLowerLeg: q(112, 0, 0),
    spine: q(-14, 0, 0),
    leftUpperArm: q(-30, 0, 0),
    rightUpperArm: q(-30, 0, 0),
  },
  kneel_single: {
    leftUpperLeg: q(-88, 0, 0),
    leftLowerLeg: q(92, 0, 0),
    rightUpperLeg: q(-8, 0, 0),
    rightLowerLeg: q(96, 0, 0),
    rightFoot: q(-38, 0, 0),
    spine: q(-6, 0, 0),
  },
  kneel_double: {
    leftUpperLeg: q(-88, 0, 0),
    rightUpperLeg: q(-88, 0, 0),
    leftLowerLeg: q(94, 0, 0),
    rightLowerLeg: q(94, 0, 0),
    spine: q(-8, 0, 0),
  },
  hands_hips: {
    leftUpperArm: q(-16, 0, -38),
    rightUpperArm: q(-16, 0, 38),
    leftLowerArm: q(0, 0, -78),
    rightLowerArm: q(0, 0, 78),
  },
  lean: {
    spine: q(-12, 0, 0),
    chest: q(-4, 0, 0),
    head: q(6, 0, 0),
  },
  bow: {
    spine: q(-34, 0, 0),
    chest: q(-22, 0, 0),
    neck: q(-8, 0, 0),
    head: q(14, 0, 0),
  },
  think: {
    rightUpperArm: q(-52, 0, 12),
    rightLowerArm: q(-96, 0, 0),
    head: q(-8, 0, 4),
  },
  fight: {
    leftUpperArm: q(-52, 0, -24),
    leftLowerArm: q(-82, 0, 0),
    rightUpperArm: q(-30, 0, 20),
    rightLowerArm: q(-92, 0, 0),
    spine: q(4, -12, 0),
  },
  kick: {
    rightUpperLeg: q(-82, 0, 0),
    rightLowerLeg: q(14, 0, 0),
    leftUpperArm: q(28, 0, -18),
    rightUpperArm: q(-24, 0, 18),
    spine: q(-6, 0, 0),
  },
  throw: {
    rightUpperArm: q(-128, 0, 14),
    rightLowerArm: q(-16, 0, 0),
    leftUpperArm: q(-34, 0, -12),
    spine: q(8, 10, 0),
  },
  push: {
    leftUpperArm: q(-74, 0, -10),
    rightUpperArm: q(-74, 0, 10),
    leftLowerArm: q(-6, 0, 0),
    rightLowerArm: q(-6, 0, 0),
    spine: q(14, 0, 0),
  },
  wave: {
    rightUpperArm: q(0, 0, 142),
    rightLowerArm: q(0, 0, 16),
    head: q(0, 8, 0),
  },
  reach: {
    rightUpperArm: q(-82, 0, 6),
    rightLowerArm: q(-4, 0, 0),
    spine: q(4, 0, 0),
  },
  arms_crossed: {
    leftUpperArm: q(-48, 0, -22),
    rightUpperArm: q(-48, 0, 22),
    leftLowerArm: q(-82, 0, 0),
    rightLowerArm: q(-82, 0, 0),
  },
  phone: {
    rightUpperArm: q(-26, 0, 10),
    rightLowerArm: q(-112, 0, 0),
    head: q(-6, 0, 0),
  },
};

/** The four-legged starting points, in local rotations. */
export const ANIMAL_POSES: Record<
  Extract<
    DirectorPose,
    | "animal_stand"
    | "animal_sit"
    | "animal_lie"
    | "animal_walk"
    | "animal_run"
    | "animal_alert"
  >,
  Record<string, DirectorQuat>
> = {
  animal_stand: {},
  animal_sit: {
    hips: q(12, 0, 0),
    spine: q(-10, 0, 0),
    rearLeftUpperLeg: q(66, 0, 0),
    rearRightUpperLeg: q(66, 0, 0),
    rearLeftLowerLeg: q(-96, 0, 0),
    rearRightLowerLeg: q(-96, 0, 0),
    frontLeftUpperLeg: q(-8, 0, 0),
    frontRightUpperLeg: q(-8, 0, 0),
    neck: q(6, 0, 0),
    tail: q(-18, 0, 0),
  },
  animal_lie: {
    hips: q(10, 0, 0),
    spine: q(-8, 0, 0),
    rearLeftUpperLeg: q(82, 0, -18),
    rearRightUpperLeg: q(82, 0, 18),
    rearLeftLowerLeg: q(-118, 0, 0),
    rearRightLowerLeg: q(-118, 0, 0),
    frontLeftUpperLeg: q(74, 0, -14),
    frontRightUpperLeg: q(74, 0, 14),
    frontLeftLowerLeg: q(-108, 0, 0),
    frontRightLowerLeg: q(-108, 0, 0),
    neck: q(-10, 0, 0),
    head: q(-6, 0, 0),
    tail: q(-8, 0, 0),
  },
  animal_walk: {
    frontLeftUpperLeg: q(26, 0, 0),
    frontRightUpperLeg: q(-26, 0, 0),
    rearLeftUpperLeg: q(-26, 0, 0),
    rearRightUpperLeg: q(26, 0, 0),
    neck: q(4, 0, 0),
  },
  animal_run: {
    frontLeftUpperLeg: q(48, 0, 0),
    frontRightUpperLeg: q(-48, 0, 0),
    rearLeftUpperLeg: q(-48, 0, 0),
    rearRightUpperLeg: q(48, 0, 0),
    frontLeftLowerLeg: q(-30, 0, 0),
    frontRightLowerLeg: q(-30, 0, 0),
    rearLeftLowerLeg: q(30, 0, 0),
    rearRightLowerLeg: q(30, 0, 0),
    spine: q(4, 0, 0),
    tail: q(-24, 0, 0),
  },
  animal_alert: {
    neck: q(-28, 0, 0),
    head: q(-6, 0, 0),
    tail: q(-38, 0, 0),
    spine: q(-2, 0, 0),
  },
};

/** The rotation a pose adds to one bone, or undefined when it leaves it be. */
export function poseRotation(
  pose: DirectorPose | undefined,
  bone: DirectorBone,
): DirectorQuat | undefined {
  if (!pose) return undefined;
  if (pose in HUMANOID_POSES) {
    return (HUMANOID_POSES as Record<string, Record<string, DirectorQuat>>)[
      pose
    ][bone];
  }
  return ANIMAL_POSES[pose as keyof typeof ANIMAL_POSES]?.[bone];
}

function quaternion(value: DirectorQuat): Quaternion {
  return new Quaternion(value[0], value[1], value[2], value[3]);
}

function easeProgress(kind: string | undefined, t: number): number {
  if (kind === "step") return 0;
  if (kind === "smooth") return t * t * (3 - 2 * t);
  return t;
}

/** One bone track's rotation at a time, or undefined when the track is empty. */
export function sampleBoneTrack(
  track: DirectorBoneTrack | undefined,
  time: number,
): DirectorQuat | undefined {
  const frames = track?.keyframes;
  if (!frames || frames.length === 0) return undefined;
  const sorted = [...frames].sort((a, b) => a.time - b.time);
  if (time <= sorted[0].time) return [...sorted[0].rotation];
  if (time >= sorted[sorted.length - 1].time) {
    return [...sorted[sorted.length - 1].rotation];
  }
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const from = sorted[index];
    const to = sorted[index + 1];
    if (time < from.time || time > to.time) continue;
    const span = to.time - from.time;
    const raw = span <= 0 ? 1 : (time - from.time) / span;
    const t = easeProgress(from.easing, raw);
    const quat = quaternion(from.rotation).slerp(quaternion(to.rotation), t);
    return [quat.x, quat.y, quat.z, quat.w];
  }
  return [...sorted[sorted.length - 1].rotation];
}

/**
 * The rotation a bone is drawn at: its keyframes, then its static override,
 * then the pose it stands in. Undefined means nothing in the document moves
 * it, which an imported model reads as "leave the mixer's own pose alone".
 */
export function boneRotation(
  object: DirectorObject,
  bone: DirectorBone,
  time: number,
): DirectorQuat | undefined {
  const track = object.boneTracks?.find((entry) => entry.bone === bone);
  const keyed = sampleBoneTrack(track, time);
  if (keyed) return keyed;
  const override = object.boneOverrides?.[bone];
  if (override) return override;
  const posed = poseRotation(object.pose, bone);
  return posed;
}

/** The identity a procedural bone stands at when nothing moves it. */
export function boneRotationOrIdentity(
  object: DirectorObject,
  bone: DirectorBone,
  time: number,
): DirectorQuat {
  return boneRotation(object, bone, time) ?? IDENTITY;
}
