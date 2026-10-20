import {
  DIRECTOR_HUMANOID_BONES,
  type DirectorHumanoidBone,
  type DirectorRig,
} from "../../../shared/domain";

/** A bone name as the matcher reads it: letters and digits, lower case. */
export function normalizeBoneName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The words a common rig uses for each humanoid joint.
 *
 * The table is a list of fragments rather than whole names because every DCC
 * and every retargeting pipeline decorates them differently: Mixamo prefixes,
 * side suffixes, `.001` copies. A fragment that appears in the normalized
 * name is enough; the first match in this order wins.
 */
const PATTERNS: [DirectorHumanoidBone, string[]][] = [
  ["hips", ["hips", "pelvis"]],
  ["spine", ["spine1", "lowerback", "spine"]],
  ["chest", ["spine2", "chest", "upperback"]],
  ["neck", ["neck"]],
  ["head", ["head"]],
  ["leftShoulder", ["leftshoulder", "shoulderl", "claviclel"]],
  ["leftUpperArm", ["leftupperarm", "leftarm", "upperarml"]],
  ["leftLowerArm", ["leftforearm", "leftlowerarm", "forearml", "lowerarml"]],
  ["leftHand", ["lefthand", "handl"]],
  ["rightShoulder", ["rightshoulder", "shoulderr", "clavicler"]],
  ["rightUpperArm", ["rightupperarm", "rightarm", "upperarmr"]],
  ["rightLowerArm", ["rightforearm", "rightlowerarm", "forearmr", "lowerarmr"]],
  ["rightHand", ["righthand", "handr"]],
  ["leftUpperLeg", ["leftupleg", "leftthigh", "upperlegl"]],
  ["leftLowerLeg", ["leftleg", "leftcalf", "lowerlegl"]],
  ["leftFoot", ["leftfoot", "footl"]],
  ["rightUpperLeg", ["rightupleg", "rightthigh", "upperlegr"]],
  ["rightLowerLeg", ["rightleg", "rightcalf", "lowerlegr"]],
  ["rightFoot", ["rightfoot", "footr"]],
];

/**
 * The joints a rig's own bone names line up with.
 *
 * Matching is by fragment, not by equality, so Mixamo's prefixed names,
 * Unreal's suffixes, and Blender's decorated copies all land on the same
 * humanoid bone. A bone claimed by an earlier match is not offered again.
 */
export function autoBoneMap(
  boneNames: readonly string[],
): Partial<Record<DirectorHumanoidBone, string>> {
  const map: Partial<Record<DirectorHumanoidBone, string>> = {};
  const taken = new Set<string>();
  for (const [bone, fragments] of PATTERNS) {
    const found = boneNames.find((name) => {
      if (taken.has(name)) return false;
      const normalized = normalizeBoneName(name);
      return fragments.some((fragment) => normalized.includes(fragment));
    });
    if (found) {
      map[bone] = found;
      taken.add(found);
    }
  }
  return map;
}

/** Whether a mapping names enough joints to be driven as a humanoid. */
export function rigReady(
  map: Partial<Record<DirectorHumanoidBone, string>>,
): boolean {
  return (
    Object.values(map).filter(
      (name) => typeof name === "string" && name.trim() !== "",
    ).length >= 8
  );
}

export function rigFromBones(
  boneNames: readonly string[],
  animationNames: readonly string[],
): DirectorRig {
  const boneMap = autoBoneMap(boneNames);
  return {
    status: rigReady(boneMap) ? "ready" : "unmapped",
    boneMap,
    animationNames: [...animationNames],
  };
}

/** The model bone a humanoid joint is mapped to, when it is mapped. */
export function modelBoneFor(
  rig: DirectorRig | undefined,
  bone: DirectorHumanoidBone,
): string | undefined {
  const name = rig?.boneMap[bone];
  return name && name.trim() ? name : undefined;
}

/** Every humanoid joint the mapping UI offers, in skeleton order. */
export const MAPPABLE_BONES: readonly DirectorHumanoidBone[] =
  DIRECTOR_HUMANOID_BONES;
