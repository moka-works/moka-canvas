import { i18n } from "../i18n";
import { MAX_PROMPT_LENGTH } from "./constants";
import { newId, nowIso } from "./ids";
import type { AssetId, IsoTimestamp, NodeId } from "./types";

/**
 * The director desk: a scene staged in metres, before a frame is made.
 *
 * A scene is a document of its own, held at the top of `.moka` beside the
 * timelines and the stories, so a project folder carries the staging with it.
 * Everything here is plain data and plain arithmetic; nothing reaches for a
 * renderer, which keeps the same rules usable in a command, a decoder, and a
 * test.
 */

export type DirectorSchemaVersion = 1;
export type DirectorVec3 = [number, number, number];
export type DirectorQuat = [number, number, number, number];

export type DirectorSolidShape = "box" | "sphere" | "cylinder" | "plane";
export type DirectorObjectKind = "solid" | "model" | "performer" | "plate";
/** The form is derived from the archetype and is never stored. */
export type DirectorActorForm = "humanoid" | "quadruped";
export type DirectorHumanoidArchetype =
  "standard" | "youth" | "senior" | "broad" | "slim" | "stylized";
export type DirectorAnimalArchetype = "dog" | "horse";
export type DirectorActorArchetype =
  DirectorHumanoidArchetype | DirectorAnimalArchetype;
export type DirectorActorAccessory = "none" | "cane" | "horns" | "crown";
export type DirectorHumanoidPose =
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
  | "phone";
export type DirectorAnimalPose =
  | "animal_stand"
  | "animal_sit"
  | "animal_lie"
  | "animal_walk"
  | "animal_run"
  | "animal_alert";
export type DirectorPose = DirectorHumanoidPose | DirectorAnimalPose;
export type DirectorEasing = "step" | "linear" | "smooth";
export type DirectorCameraMove =
  | "static"
  | "push_in"
  | "pull_out"
  | "pan_left"
  | "pan_right"
  | "tilt_up"
  | "tilt_down"
  | "orbit_left"
  | "orbit_right"
  | "handheld";
export type DirectorShotSize =
  "extreme_wide" | "wide" | "full" | "medium" | "close_up" | "extreme_close_up";
export type DirectorAspectRatio = "16:9" | "9:16" | "4:5" | "2.39:1";
export type DirectorRenderMode =
  "lit" | "blockout" | "depth" | "normal" | "silhouette";
export type DirectorHumanoidBone =
  | "root"
  | "hips"
  | "spine"
  | "chest"
  | "neck"
  | "head"
  | "leftShoulder"
  | "leftUpperArm"
  | "leftLowerArm"
  | "leftHand"
  | "rightShoulder"
  | "rightUpperArm"
  | "rightLowerArm"
  | "rightHand"
  | "leftUpperLeg"
  | "leftLowerLeg"
  | "leftFoot"
  | "rightUpperLeg"
  | "rightLowerLeg"
  | "rightFoot"
  | DirectorFingerBone;
export type DirectorQuadrupedBone =
  | "root"
  | "hips"
  | "spine"
  | "chest"
  | "neck"
  | "head"
  | "tail"
  | "frontLeftUpperLeg"
  | "frontLeftLowerLeg"
  | "frontLeftPaw"
  | "frontRightUpperLeg"
  | "frontRightLowerLeg"
  | "frontRightPaw"
  | "rearLeftUpperLeg"
  | "rearLeftLowerLeg"
  | "rearLeftPaw"
  | "rearRightUpperLeg"
  | "rearRightLowerLeg"
  | "rearRightPaw";
export type DirectorBone = DirectorHumanoidBone | DirectorQuadrupedBone;

/**
 * The finger bones a mapped hand may carry.
 *
 * They are a group rather than thirty separate controls: the viewport offers
 * one point per hand, and the inspector expands the joints inside it.
 */
export const DIRECTOR_FINGER_BONES = [
  "leftThumb1",
  "leftThumb2",
  "leftThumb3",
  "leftIndex1",
  "leftIndex2",
  "leftIndex3",
  "leftMiddle1",
  "leftMiddle2",
  "leftMiddle3",
  "leftRing1",
  "leftRing2",
  "leftRing3",
  "leftPinky1",
  "leftPinky2",
  "leftPinky3",
  "rightThumb1",
  "rightThumb2",
  "rightThumb3",
  "rightIndex1",
  "rightIndex2",
  "rightIndex3",
  "rightMiddle1",
  "rightMiddle2",
  "rightMiddle3",
  "rightRing1",
  "rightRing2",
  "rightRing3",
  "rightPinky1",
  "rightPinky2",
  "rightPinky3",
] as const;
export type DirectorFingerBone = (typeof DIRECTOR_FINGER_BONES)[number];

export interface DirectorTransform {
  position: DirectorVec3;
  rotation: DirectorVec3;
  scale: DirectorVec3;
}

export interface DirectorKeyframe {
  id: string;
  time: number;
  transform: DirectorTransform;
  easing?: DirectorEasing;
}

export interface DirectorBoneKeyframe {
  id: string;
  time: number;
  rotation: DirectorQuat;
  easing?: DirectorEasing;
}

export interface DirectorBoneTrack {
  bone: DirectorBone;
  keyframes: DirectorBoneKeyframe[];
}

export interface DirectorActorBuild {
  /** Total height in metres. */
  stature: number;
  /** Head-to-body ratio; one is the standard adult. */
  headScale: number;
  /** Shoulder width in metres. */
  shoulderSpan: number;
  /** The torso's share of the height, 0.25–0.40. */
  torsoShare: number;
  accessory: DirectorActorAccessory;
}

export interface DirectorAnimalBuild {
  /** Shoulder height in metres. */
  shoulderHeight: number;
  /** Chest-to-haunch length in metres. */
  bodyLength: number;
  /** Body width in metres. */
  bodyWidth: number;
  /** Head scale against the archetype's own. */
  headScale: number;
}

export interface DirectorRig {
  status: "unmapped" | "ready";
  boneMap: Partial<Record<DirectorHumanoidBone, string>>;
  animationNames: string[];
}

export interface DirectorMotionClip {
  id: string;
  name: string;
  sourceAnimation: string;
  start: number;
  duration: number;
  playbackRate: number;
  loop: boolean;
}

export interface DirectorObject {
  id: string;
  name: string;
  kind: DirectorObjectKind;
  shape?: DirectorSolidShape;
  transform: DirectorTransform;
  color: string;
  visible: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
  pose?: DirectorPose;
  archetype?: DirectorActorArchetype;
  actorBuild?: DirectorActorBuild;
  animalBuild?: DirectorAnimalBuild;
  rig?: DirectorRig;
  motionClips?: DirectorMotionClip[];
  activeMotionClipId?: string;
  boneOverrides?: Partial<Record<DirectorBone, DirectorQuat>>;
  boneTracks?: DirectorBoneTrack[];
  /** The project asset a model or plate reads; absent on procedural objects. */
  assetId?: AssetId;
  /** The upstream picture this was brought in from, for the prompt's trace. */
  sourceNodeId?: NodeId;
  keyframes: DirectorKeyframe[];
}

export interface DirectorCamera {
  id: string;
  name: string;
  transform: DirectorTransform;
  target: DirectorVec3;
  /** 35mm full-frame equivalent focal length; FOV is derived, never stored. */
  focalLength: number;
  aperture: number;
  focusDistance: number;
  near: number;
  far: number;
  keyframes: DirectorKeyframe[];
}

export interface DirectorLight {
  id: string;
  name: string;
  type: "directional" | "point" | "spot" | "ambient";
  transform: DirectorTransform;
  color: string;
  intensity: number;
  /** Spot only, in radians. */
  angle?: number;
  /** Spot only, 0..1. */
  penumbra?: number;
  castShadow: boolean;
}

export interface DirectorShot {
  id: string;
  name: string;
  cameraId: string;
  /** Seconds, 0.5–60. */
  duration: number;
  fps: 24 | 25 | 30;
  aspectRatio: DirectorAspectRatio;
  shotSize: DirectorShotSize;
  cameraMove: DirectorCameraMove;
  /** The reader's own words for this shot, placed at the top of the prompt. */
  prompt: string;
}

export interface DirectorEnvironment {
  mode: "color" | "panorama";
  /** Required in panorama mode; points into `resources.images`. */
  assetId?: AssetId;
  rotationY?: number;
  exposure?: number;
  useAsLighting?: boolean;
  lightingIntensity?: number;
}

export interface DirectorScene {
  id: string;
  schemaVersion: DirectorSchemaVersion;
  title: string;
  background: string;
  environmentIntensity: number;
  environment?: DirectorEnvironment;
  gridVisible: boolean;
  objects: DirectorObject[];
  cameras: DirectorCamera[];
  lights: DirectorLight[];
  shots: DirectorShot[];
  activeShotId: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** What a director card holds beyond the common node fields. */
export interface DirectorState {
  sceneId: string;
  frameAssetId?: AssetId;
  blockingAssetId?: AssetId;
  frameShotId?: string;
  directionText?: string;
  deliveredAt?: IsoTimestamp;
}

/** What the document of a director card carries: its scene, and its outputs. */
export interface DirectorNodeData {
  director: DirectorState;
}

// ---------------------------------------------------------------------------
// Limits and defaults
// ---------------------------------------------------------------------------

export const DIRECTOR_SCHEMA_VERSION = 1;

export const DIRECTOR_LIMITS = {
  maxScenesPerProject: 256,
  maxObjectsPerScene: 128,
  maxCamerasPerScene: 16,
  maxLightsPerScene: 32,
  maxShotsPerScene: 64,
  maxKeyframesPerTrack: 2_000,
  maxBoneTracksPerObject: 64,
  maxSceneBytes: 4 * 1024 * 1024,
  maxNameLength: 120,
  maxPromptLength: MAX_PROMPT_LENGTH,
} as const;

export const DIRECTOR_BACKGROUND = "#202630";
export const DIRECTOR_FLOOR = "#39414c";
export const DIRECTOR_ENVIRONMENT_INTENSITY = 0.6;
export const DIRECTOR_MIN_SCALE = 1e-4;

/** The sixteen stage colours; the UI's greys stay out of the cast. */
export const DIRECTOR_PALETTE = [
  "#e06c75",
  "#d98c3f",
  "#e5c07b",
  "#98c379",
  "#56b6c2",
  "#61afef",
  "#c678dd",
  "#e39ac4",
  "#f28fad",
  "#a3d9a5",
  "#7ec8e3",
  "#b5a1e0",
  "#f0a35e",
  "#8fb996",
  "#d4a5a5",
  "#9ea7b3",
] as const;

export const DIRECTOR_HUMANOID_ARCHETYPES: readonly DirectorHumanoidArchetype[] =
  ["standard", "youth", "senior", "broad", "slim", "stylized"];
export const DIRECTOR_ANIMAL_ARCHETYPES: readonly DirectorAnimalArchetype[] = [
  "dog",
  "horse",
];
export const DIRECTOR_ARCHETYPES: readonly DirectorActorArchetype[] = [
  ...DIRECTOR_HUMANOID_ARCHETYPES,
  ...DIRECTOR_ANIMAL_ARCHETYPES,
];
export const DIRECTOR_ACCESSORIES: readonly DirectorActorAccessory[] = [
  "none",
  "cane",
  "horns",
  "crown",
];
export const DIRECTOR_HUMANOID_POSES: readonly DirectorHumanoidPose[] = [
  "neutral",
  "stand",
  "t_pose",
  "walk",
  "run",
  "sit",
  "squat",
  "kneel_single",
  "kneel_double",
  "hands_hips",
  "lean",
  "bow",
  "think",
  "fight",
  "kick",
  "throw",
  "push",
  "wave",
  "reach",
  "arms_crossed",
  "phone",
];
export const DIRECTOR_ANIMAL_POSES: readonly DirectorAnimalPose[] = [
  "animal_stand",
  "animal_sit",
  "animal_lie",
  "animal_walk",
  "animal_run",
  "animal_alert",
];
export const DIRECTOR_EASINGS: readonly DirectorEasing[] = [
  "step",
  "linear",
  "smooth",
];
export const DIRECTOR_ASPECT_RATIOS: readonly DirectorAspectRatio[] = [
  "16:9",
  "9:16",
  "4:5",
  "2.39:1",
];
export const DIRECTOR_SHOT_SIZES: readonly DirectorShotSize[] = [
  "extreme_wide",
  "wide",
  "full",
  "medium",
  "close_up",
  "extreme_close_up",
];
export const DIRECTOR_CAMERA_MOVES: readonly DirectorCameraMove[] = [
  "static",
  "push_in",
  "pull_out",
  "pan_left",
  "pan_right",
  "tilt_up",
  "tilt_down",
  "orbit_left",
  "orbit_right",
  "handheld",
];
export const DIRECTOR_RENDER_MODES: readonly DirectorRenderMode[] = [
  "lit",
  "blockout",
  "depth",
  "normal",
  "silhouette",
];
/** Modes that are control passes for the shelf rather than a shot's look. */
export const DIRECTOR_CONTROL_MODES: readonly DirectorRenderMode[] = [
  "depth",
  "normal",
  "silhouette",
];

/** Whether a frame in this mode is a control pass, shelf-only. */
export function directorControlMode(mode: DirectorRenderMode): boolean {
  return (DIRECTOR_CONTROL_MODES as readonly string[]).includes(mode);
}
export const DIRECTOR_SHOT_FPS = [24, 25, 30] as const;
export const DIRECTOR_LIGHT_TYPES = [
  "directional",
  "point",
  "spot",
  "ambient",
] as const;
export const DIRECTOR_OBJECT_KINDS: readonly DirectorObjectKind[] = [
  "solid",
  "model",
  "performer",
  "plate",
];
export const DIRECTOR_SOLID_SHAPES: readonly DirectorSolidShape[] = [
  "box",
  "sphere",
  "cylinder",
  "plane",
];

/** The proportions each humanoid starting point is built from. */
export const DIRECTOR_HUMANOID_BUILDS: Record<
  DirectorHumanoidArchetype,
  DirectorActorBuild
> = {
  standard: {
    stature: 1.68,
    headScale: 1,
    shoulderSpan: 0.44,
    torsoShare: 0.3,
    accessory: "none",
  },
  youth: {
    stature: 1.18,
    headScale: 1.22,
    shoulderSpan: 0.34,
    torsoShare: 0.29,
    accessory: "none",
  },
  senior: {
    stature: 1.58,
    headScale: 1.04,
    shoulderSpan: 0.41,
    torsoShare: 0.3,
    accessory: "cane",
  },
  broad: {
    stature: 1.8,
    headScale: 0.95,
    shoulderSpan: 0.52,
    torsoShare: 0.31,
    accessory: "none",
  },
  slim: {
    stature: 1.66,
    headScale: 1,
    shoulderSpan: 0.37,
    torsoShare: 0.31,
    accessory: "none",
  },
  stylized: {
    stature: 1.42,
    headScale: 1.35,
    shoulderSpan: 0.4,
    torsoShare: 0.29,
    accessory: "none",
  },
};

export const DIRECTOR_ANIMAL_BUILDS: Record<
  DirectorAnimalArchetype,
  DirectorAnimalBuild
> = {
  dog: {
    shoulderHeight: 0.58,
    bodyLength: 0.95,
    bodyWidth: 0.22,
    headScale: 1,
  },
  horse: {
    shoulderHeight: 1.55,
    bodyLength: 2.36,
    bodyWidth: 0.48,
    headScale: 1,
  },
};

export const DIRECTOR_HUMANOID_BONES: readonly DirectorHumanoidBone[] = [
  "root",
  "hips",
  "spine",
  "chest",
  "neck",
  "head",
  "leftShoulder",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightShoulder",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  ...DIRECTOR_FINGER_BONES,
];

/**
 * The joints a procedural humanoid is built with.
 *
 * A programmatic body has no fingers: its hand is one joint, so offering
 * thirty finger controls would name bones that are not on the stage. Those
 * appear only when an imported rig maps them.
 */
export const DIRECTOR_HUMANOID_BODY_BONES: readonly DirectorHumanoidBone[] =
  DIRECTOR_HUMANOID_BONES.filter(
    (bone) => !(DIRECTOR_FINGER_BONES as readonly string[]).includes(bone),
  );

export const DIRECTOR_QUADRUPED_BONES: readonly DirectorQuadrupedBone[] = [
  "root",
  "hips",
  "spine",
  "chest",
  "neck",
  "head",
  "tail",
  "frontLeftUpperLeg",
  "frontLeftLowerLeg",
  "frontLeftPaw",
  "frontRightUpperLeg",
  "frontRightLowerLeg",
  "frontRightPaw",
  "rearLeftUpperLeg",
  "rearLeftLowerLeg",
  "rearLeftPaw",
  "rearRightUpperLeg",
  "rearRightLowerLeg",
  "rearRightPaw",
];

/** Whether an archetype is drawn on two legs or four. */
export function actorFormFor(
  archetype: DirectorActorArchetype,
): DirectorActorForm {
  return archetype === "dog" || archetype === "horse"
    ? "quadruped"
    : "humanoid";
}

export function isHumanoidArchetype(
  value: unknown,
): value is DirectorHumanoidArchetype {
  return DIRECTOR_HUMANOID_ARCHETYPES.includes(
    value as DirectorHumanoidArchetype,
  );
}

export function isAnimalArchetype(
  value: unknown,
): value is DirectorAnimalArchetype {
  return DIRECTOR_ANIMAL_ARCHETYPES.includes(value as DirectorAnimalArchetype);
}

/** The pose a new actor of this archetype starts in. */
export function defaultPoseFor(
  archetype: DirectorActorArchetype,
): DirectorPose {
  return actorFormFor(archetype) === "quadruped" ? "animal_stand" : "neutral";
}

/** The bones a form offers, in the order the inspector lists them. */
export function bonesFor(form: DirectorActorForm): readonly DirectorBone[] {
  return form === "quadruped"
    ? DIRECTOR_QUADRUPED_BONES
    : DIRECTOR_HUMANOID_BONES;
}

/** The poses a form offers. */
export function posesFor(form: DirectorActorForm): readonly DirectorPose[] {
  return form === "quadruped" ? DIRECTOR_ANIMAL_POSES : DIRECTOR_HUMANOID_POSES;
}

// ---------------------------------------------------------------------------
// The templates
// ---------------------------------------------------------------------------

export const DIRECTOR_TEMPLATE_IDS = [
  "empty",
  "solo",
  "duo",
  "ensemble",
  "tabletop",
] as const;
export type DirectorTemplateId = (typeof DIRECTOR_TEMPLATE_IDS)[number];

export function isDirectorTemplateId(
  value: unknown,
): value is DirectorTemplateId {
  return DIRECTOR_TEMPLATE_IDS.includes(value as DirectorTemplateId);
}

/** The words a template is offered in; the catalogue holds the sentences. */
export const DIRECTOR_TEMPLATE_LABELS: Record<DirectorTemplateId, string> = {
  empty: "director:templates.empty.name",
  solo: "director:templates.solo.name",
  duo: "director:templates.duo.name",
  ensemble: "director:templates.ensemble.name",
  tabletop: "director:templates.tabletop.name",
};

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function identityScale(): DirectorVec3 {
  return [1, 1, 1];
}

export function directorTransform(
  position: DirectorVec3 = [0, 0, 0],
  rotation: DirectorVec3 = [0, 0, 0],
  scale: DirectorVec3 = identityScale(),
): DirectorTransform {
  return { position, rotation, scale };
}

/** The default camera: 40mm, three-quarters front, looking at chest height. */
export function defaultDirectorCamera(
  name: string,
  overrides: Partial<DirectorCamera> = {},
): DirectorCamera {
  return {
    id: newId(),
    name,
    transform: directorTransform([6, 2.6, 7.8]),
    target: [0, 1.05, 0],
    focalLength: 40,
    aperture: 2.8,
    focusDistance: 5.5,
    near: 0.08,
    far: 400,
    keyframes: [],
    ...overrides,
  };
}

/**
 * The three-point light every template starts from: a warm key from the right
 * front, a cool rim from behind left, and a flat ambient fill.
 */
export function defaultDirectorLights(): DirectorLight[] {
  const light = (
    name: string,
    type: DirectorLight["type"],
    position: DirectorVec3,
    color: string,
    intensity: number,
    castShadow: boolean,
  ): DirectorLight => ({
    id: newId(),
    name,
    type,
    transform: directorTransform(position),
    color,
    intensity,
    castShadow,
  });
  return [
    light(
      i18n.t("director:defaults.keyLight"),
      "directional",
      [4, 6, 4],
      "#fff1e0",
      2.6,
      true,
    ),
    light(
      i18n.t("director:defaults.rimLight"),
      "directional",
      [-5, 4.5, -4],
      "#d9e7ff",
      1.2,
      false,
    ),
    light(
      i18n.t("director:defaults.ambientLight"),
      "ambient",
      [0, 0, 0],
      "#ffffff",
      0.55,
      false,
    ),
  ];
}

/** A shot of the scene's default shape: 16:9, 30fps, six seconds, medium. */
export function defaultDirectorShot(
  name: string,
  cameraId: string,
  overrides: Partial<DirectorShot> = {},
): DirectorShot {
  return {
    id: newId(),
    name,
    cameraId,
    duration: 6,
    fps: 30,
    aspectRatio: "16:9",
    shotSize: "medium",
    cameraMove: "static",
    prompt: "",
    ...overrides,
  };
}

export function createPerformer(
  archetype: DirectorActorArchetype,
  name: string,
  color: string,
  position: DirectorVec3,
  rotation: DirectorVec3 = [0, 0, 0],
): DirectorObject {
  const form = actorFormFor(archetype);
  const object: DirectorObject = {
    id: newId(),
    name,
    kind: "performer",
    transform: directorTransform(position, rotation),
    color,
    visible: true,
    castShadow: true,
    receiveShadow: true,
    pose: defaultPoseFor(archetype),
    archetype,
    keyframes: [],
  };
  if (form === "quadruped") {
    object.animalBuild = {
      ...DIRECTOR_ANIMAL_BUILDS[archetype as DirectorAnimalArchetype],
    };
  } else {
    object.actorBuild = {
      ...DIRECTOR_HUMANOID_BUILDS[archetype as DirectorHumanoidArchetype],
    };
  }
  return object;
}

/** A solid whose scale is its size in metres; the geometry is one unit. */
export function createSolid(
  shape: DirectorSolidShape,
  name: string,
  color: string,
  size: DirectorVec3,
  position: DirectorVec3,
  rotation: DirectorVec3 = [0, 0, 0],
): DirectorObject {
  return {
    id: newId(),
    name,
    kind: "solid",
    shape,
    transform: directorTransform(position, rotation, size),
    color,
    visible: true,
    castShadow: true,
    receiveShadow: true,
    keyframes: [],
  };
}

export function createModel(
  assetId: AssetId,
  name: string,
  position: DirectorVec3,
  rotation: DirectorVec3 = [0, 0, 0],
): DirectorObject {
  return {
    id: newId(),
    name,
    kind: "model",
    transform: directorTransform(position, rotation),
    color: DIRECTOR_PALETTE[0],
    visible: true,
    castShadow: true,
    receiveShadow: true,
    assetId,
    keyframes: [],
  };
}

export function createPlate(
  assetId: AssetId,
  name: string,
  position: DirectorVec3,
  rotation: DirectorVec3 = [0, 0, 0],
  size: DirectorVec3 = [1.6, 0.9, 1],
  sourceNodeId?: NodeId,
): DirectorObject {
  return {
    id: newId(),
    name,
    kind: "plate",
    transform: directorTransform(position, rotation, size),
    color: "#ffffff",
    visible: true,
    castShadow: false,
    receiveShadow: true,
    assetId,
    ...(sourceNodeId !== undefined ? { sourceNodeId } : {}),
    keyframes: [],
  };
}

const TEMPLATE_ACTOR_COLOR = (index: number) =>
  DIRECTOR_PALETTE[index % DIRECTOR_PALETTE.length];

/**
 * A scene from one of the five starting points, or the empty stage for a
 * template this build does not know: an unknown name falls back rather than
 * failing, because a document is read by a build that may be newer.
 */
export function createDirectorScene(
  title: string,
  template: DirectorTemplateId | string = "empty",
): DirectorScene {
  const now = nowIso();
  const camera = defaultDirectorCamera(i18n.t("director:defaults.cameraName"));
  const shot = defaultDirectorShot(
    i18n.t("director:defaults.shotName"),
    camera.id,
  );
  const scene: DirectorScene = {
    id: newId(),
    schemaVersion: DIRECTOR_SCHEMA_VERSION,
    title,
    background: DIRECTOR_BACKGROUND,
    environmentIntensity: DIRECTOR_ENVIRONMENT_INTENSITY,
    gridVisible: true,
    objects: [],
    cameras: [camera],
    lights: defaultDirectorLights(),
    shots: [shot],
    activeShotId: shot.id,
    createdAt: now,
    updatedAt: now,
  };

  const chosen = isDirectorTemplateId(template) ? template : "empty";
  switch (chosen) {
    case "empty":
      break;
    case "solo": {
      scene.objects.push(
        createPerformer(
          "standard",
          i18n.t("director:defaults.actorName", { n: 1 }),
          TEMPLATE_ACTOR_COLOR(0),
          [-0.9, 0, 0.2],
          [0, 0.35, 0],
        ),
        createSolid(
          "box",
          i18n.t("director:props.window"),
          "#5b6472",
          [1.4, 1.2, 0.12],
          [-1.9, 0.6, -0.3],
          [0, 0.35, 0],
        ),
      );
      applyCamera(scene, camera.id, {
        transform: directorTransform([2.4, 1.7, 3.4]),
        target: [-0.4, 1.1, 0],
        focalLength: 45,
        focusDistance: 4.4,
      });
      break;
    }
    case "duo": {
      scene.objects.push(
        createSolid(
          "box",
          i18n.t("director:props.longTable"),
          "#6b5a4a",
          [1.8, 0.76, 0.9],
          [0, 0.38, 0],
        ),
        createPerformer(
          "standard",
          i18n.t("director:defaults.actorName", { n: 1 }),
          TEMPLATE_ACTOR_COLOR(0),
          [-1.1, 0, 0],
          [0, Math.PI / 2, 0],
        ),
        createPerformer(
          "slim",
          i18n.t("director:defaults.actorName", { n: 2 }),
          TEMPLATE_ACTOR_COLOR(1),
          [1.1, 0, 0],
          [0, -Math.PI / 2, 0],
        ),
      );
      scene.objects[1].pose = "sit";
      scene.objects[2].pose = "sit";
      applyCamera(scene, camera.id, {
        transform: directorTransform([3, 1.7, 3.2]),
        target: [0, 1, 0],
        focalLength: 35,
        focusDistance: 4.4,
      });
      shot.duration = 8;
      break;
    }
    case "ensemble": {
      const places: [DirectorVec3, number, DirectorHumanoidArchetype][] = [
        [[-2.2, 0, -0.8], 0.5, "standard"],
        [[0.2, 0, 0.6], Math.PI, "broad"],
        [[2, 0, -1.4], -0.6, "slim"],
      ];
      places.forEach(([position, facing, archetype], index) => {
        scene.objects.push(
          createPerformer(
            archetype,
            i18n.t("director:defaults.actorName", { n: index + 1 }),
            TEMPLATE_ACTOR_COLOR(index),
            position,
            [0, facing, 0],
          ),
        );
      });
      applyCamera(scene, camera.id, {
        transform: directorTransform([7.2, 3, 8.2]),
        target: [0, 1, 0],
        focalLength: 24,
        focusDistance: 10.5,
      });
      shot.duration = 8;
      shot.shotSize = "wide";
      break;
    }
    case "tabletop": {
      scene.objects.push(
        createSolid(
          "plane",
          i18n.t("director:props.backdrop"),
          "#3a4250",
          [4, 2.4, 1],
          [0, 1.2, -1.4],
        ),
        createSolid(
          "cylinder",
          i18n.t("director:props.subject"),
          "#c9a26b",
          [0.5, 0.7, 0.5],
          [0, 0.35, 0],
        ),
        createSolid(
          "box",
          i18n.t("director:props.sideProp"),
          "#7d8794",
          [0.5, 0.3, 0.5],
          [0.8, 0.15, 0.1],
        ),
      );
      applyCamera(scene, camera.id, {
        transform: directorTransform([0, 1.25, 3.4]),
        target: [0, 0.75, 0],
        focalLength: 80,
        focusDistance: 3.5,
      });
      shot.duration = 5;
      shot.shotSize = "close_up";
      break;
    }
  }
  return scene;
}

function applyCamera(
  scene: DirectorScene,
  cameraId: string,
  patch: Partial<DirectorCamera>,
): void {
  const camera = scene.cameras.find((candidate) => candidate.id === cameraId);
  if (camera) Object.assign(camera, patch);
}

/**
 * The room a new object needs, in metres, as a footprint on the floor.
 *
 * A performer is a person's footprint rather than their shoulders, a plate is
 * thin behind the subject, and a solid is its own scaled size.
 */
export function objectFootprint(object: DirectorObject): {
  halfX: number;
  halfZ: number;
} {
  switch (object.kind) {
    case "performer":
      return { halfX: 0.4, halfZ: 0.4 };
    case "model":
      return { halfX: 0.95, halfZ: 0.95 };
    case "plate":
      return { halfX: 0.8, halfZ: 0.15 };
    case "solid": {
      const [width, , depth] = object.transform.scale;
      return { halfX: Math.abs(width) / 2, halfZ: Math.abs(depth) / 2 };
    }
  }
}

function overlap(
  a: { x: number; z: number; halfX: number; halfZ: number },
  b: { x: number; z: number; halfX: number; halfZ: number },
): boolean {
  return (
    Math.abs(a.x - b.x) < a.halfX + b.halfX &&
    Math.abs(a.z - b.z) < a.halfZ + b.halfZ
  );
}

/**
 * The first place near an anchor where a new object fits, found the same way
 * every time: rings of eight-tenths of a metre, ten points each, and past the
 * last ring the right edge of everything already placed.
 *
 * Hidden objects take part: hiding something is not an invitation to stand
 * where it is, and the document's geometry stays where the reader put it.
 */
export function freePosition(
  objects: readonly DirectorObject[],
  footprint: { halfX: number; halfZ: number },
  anchor: { x: number; z: number },
): [number, number] {
  const step = 0.8;
  const rings = 20;
  const points = 10;
  const taken = objects.map((object) => {
    const spot = objectFootprint(object);
    return {
      x: object.transform.position[0],
      z: object.transform.position[2],
      ...spot,
    };
  });
  const fits = (x: number, z: number) =>
    !taken.some((other) => overlap({ x, z, ...footprint }, other));
  if (fits(anchor.x, anchor.z)) return [anchor.x, anchor.z];
  for (let ring = 1; ring <= rings; ring += 1) {
    for (let point = 0; point < points; point += 1) {
      const angle = (point / points) * Math.PI * 2;
      const x = anchor.x + Math.cos(angle) * step * ring;
      const z = anchor.z + Math.sin(angle) * step * ring;
      if (fits(x, z)) return [x, z];
    }
  }
  let right = -Infinity;
  for (const other of taken) right = Math.max(right, other.x + other.halfX);
  return [right + footprint.halfX + step, anchor.z];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface DirectorIssue {
  code: string;
  path: string;
  message: string;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function vec3(value: unknown): value is DirectorVec3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((entry) => finite(entry))
  );
}

function quat(value: unknown): value is DirectorQuat {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((entry) => finite(entry))
  );
}

function hexColor(value: unknown): boolean {
  return typeof value === "string" && /^#[0-9a-f]{6}$/.test(value);
}

function oneOf<T extends string>(
  allowed: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function transformIssues(
  transform: DirectorTransform | undefined,
  path: string,
  issues: DirectorIssue[],
): void {
  if (!transform) {
    issues.push({
      code: "DIRECTOR_REFERENCE_INVALID",
      path,
      message: `${path} is missing`,
    });
    return;
  }
  if (!vec3(transform.position))
    issues.push({
      code: "VALIDATION_FAILED",
      path: `${path}.position`,
      message: `${path}.position must be three finite numbers`,
    });
  if (!vec3(transform.rotation))
    issues.push({
      code: "VALIDATION_FAILED",
      path: `${path}.rotation`,
      message: `${path}.rotation must be three finite numbers`,
    });
  if (
    !vec3(transform.scale) ||
    transform.scale.some((axis) => Math.abs(axis) < DIRECTOR_MIN_SCALE)
  )
    issues.push({
      code: "VALIDATION_FAILED",
      path: `${path}.scale`,
      message: `${path}.scale must be three numbers with no axis near zero`,
    });
}

function keyframeIssues(
  keyframes: DirectorKeyframe[] | undefined,
  path: string,
  issues: DirectorIssue[],
): void {
  if (!Array.isArray(keyframes)) {
    issues.push({
      code: "DIRECTOR_REFERENCE_INVALID",
      path,
      message: `${path} is missing`,
    });
    return;
  }
  if (keyframes.length > DIRECTOR_LIMITS.maxKeyframesPerTrack)
    issues.push({
      code: "DIRECTOR_LIMIT_EXCEEDED",
      path,
      message: `${path} holds more than ${DIRECTOR_LIMITS.maxKeyframesPerTrack} keyframes`,
    });
  const seen = new Set<string>();
  keyframes.forEach((keyframe, index) => {
    const at = `${path}[${index}]`;
    if (seen.has(keyframe.id))
      issues.push({
        code: "DIRECTOR_REFERENCE_INVALID",
        path: `${at}.id`,
        message: `duplicate keyframe id "${keyframe.id}"`,
      });
    seen.add(keyframe.id);
    if (!finite(keyframe.time) || keyframe.time < 0)
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${at}.time`,
        message: `${at}.time must be a finite number of seconds`,
      });
    if (
      keyframe.easing !== undefined &&
      !oneOf(DIRECTOR_EASINGS, keyframe.easing)
    )
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${at}.easing`,
        message: `${at}.easing is not a known easing`,
      });
    transformIssues(keyframe.transform, `${at}.transform`, issues);
  });
}

function boneTrackIssues(
  object: DirectorObject,
  form: DirectorActorForm,
  issues: DirectorIssue[],
  path: string,
): void {
  const allowed = new Set<string>(bonesFor(form));
  const tracks = object.boneTracks ?? [];
  if (tracks.length > DIRECTOR_LIMITS.maxBoneTracksPerObject)
    issues.push({
      code: "DIRECTOR_LIMIT_EXCEEDED",
      path: `${path}.boneTracks`,
      message: `${path}.boneTracks holds more than ${DIRECTOR_LIMITS.maxBoneTracksPerObject} tracks`,
    });
  const seen = new Set<string>();
  tracks.forEach((track, index) => {
    const at = `${path}.boneTracks[${index}]`;
    if (!allowed.has(track.bone))
      issues.push({
        code: "DIRECTOR_REFERENCE_INVALID",
        path: `${at}.bone`,
        message: `bone "${track.bone}" does not belong to this actor's form`,
      });
    if (seen.has(track.bone))
      issues.push({
        code: "DIRECTOR_REFERENCE_INVALID",
        path: `${at}.bone`,
        message: `duplicate bone track "${track.bone}"`,
      });
    seen.add(track.bone);
    if (track.keyframes.length > DIRECTOR_LIMITS.maxKeyframesPerTrack)
      issues.push({
        code: "DIRECTOR_LIMIT_EXCEEDED",
        path: `${at}.keyframes`,
        message: `${at}.keyframes holds more than ${DIRECTOR_LIMITS.maxKeyframesPerTrack} keyframes`,
      });
    track.keyframes.forEach((keyframe, keyIndex) => {
      const frameAt = `${at}.keyframes[${keyIndex}]`;
      if (!finite(keyframe.time) || keyframe.time < 0)
        issues.push({
          code: "VALIDATION_FAILED",
          path: `${frameAt}.time`,
          message: `${frameAt}.time must be a finite number of seconds`,
        });
      if (!quat(keyframe.rotation))
        issues.push({
          code: "VALIDATION_FAILED",
          path: `${frameAt}.rotation`,
          message: `${frameAt}.rotation must be a four-number quaternion`,
        });
      if (
        keyframe.easing !== undefined &&
        !oneOf(DIRECTOR_EASINGS, keyframe.easing)
      )
        issues.push({
          code: "VALIDATION_FAILED",
          path: `${frameAt}.easing`,
          message: `${frameAt}.easing is not a known easing`,
        });
    });
  });

  for (const [bone, rotation] of Object.entries(object.boneOverrides ?? {})) {
    if (!allowed.has(bone))
      issues.push({
        code: "DIRECTOR_REFERENCE_INVALID",
        path: `${path}.boneOverrides.${bone}`,
        message: `bone "${bone}" does not belong to this actor's form`,
      });
    if (!quat(rotation))
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.boneOverrides.${bone}`,
        message: `${path}.boneOverrides.${bone} must be a four-number quaternion`,
      });
  }
}

function rigIssues(
  rig: DirectorRig | undefined,
  issues: DirectorIssue[],
  path: string,
): void {
  if (!rig) return;
  if (rig.status !== "unmapped" && rig.status !== "ready")
    issues.push({
      code: "VALIDATION_FAILED",
      path: `${path}.status`,
      message: `${path}.status is not a known rig state`,
    });
  if (!Array.isArray(rig.animationNames))
    issues.push({
      code: "VALIDATION_FAILED",
      path: `${path}.animationNames`,
      message: `${path}.animationNames must be a list`,
    });
  for (const [bone, boneName] of Object.entries(rig.boneMap ?? {})) {
    if (!oneOf(DIRECTOR_HUMANOID_BONES, bone))
      issues.push({
        code: "DIRECTOR_REFERENCE_INVALID",
        path: `${path}.boneMap.${bone}`,
        message: `"${bone}" is not a humanoid bone`,
      });
    if (typeof boneName !== "string")
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.boneMap.${bone}`,
        message: `${path}.boneMap.${bone} must name a bone or be empty`,
      });
  }
  if (rig.status === "ready") {
    const mapped = Object.values(rig.boneMap ?? {}).filter(
      (name) => typeof name === "string" && name.trim() !== "",
    ).length;
    if (mapped < 8)
      issues.push({
        code: "DIRECTOR_RIG_UNMAPPED",
        path: `${path}.boneMap`,
        message: `a ready rig maps at least eight bones; this maps ${mapped}`,
      });
  }
}

function motionIssues(
  object: DirectorObject,
  issues: DirectorIssue[],
  path: string,
): void {
  const clips = object.motionClips ?? [];
  const names = new Set(object.rig?.animationNames ?? []);
  const ids = new Set<string>();
  clips.forEach((clip, index) => {
    const at = `${path}.motionClips[${index}]`;
    if (ids.has(clip.id))
      issues.push({
        code: "DIRECTOR_REFERENCE_INVALID",
        path: `${at}.id`,
        message: `duplicate motion clip id "${clip.id}"`,
      });
    ids.add(clip.id);
    if (!names.has(clip.sourceAnimation))
      issues.push({
        code: "DIRECTOR_REFERENCE_INVALID",
        path: `${at}.sourceAnimation`,
        message: `animation "${clip.sourceAnimation}" is not in the rig`,
      });
    for (const [field, value] of [
      ["start", clip.start],
      ["duration", clip.duration],
      ["playbackRate", clip.playbackRate],
    ] as const) {
      if (!finite(value) || value < 0)
        issues.push({
          code: "VALIDATION_FAILED",
          path: `${at}.${field}`,
          message: `${at}.${field} must be a finite, non-negative number`,
        });
    }
    if (clip.duration <= 0)
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${at}.duration`,
        message: `${at}.duration must be positive`,
      });
  });
  if (
    object.activeMotionClipId !== undefined &&
    !clips.some((clip) => clip.id === object.activeMotionClipId)
  )
    issues.push({
      code: "DIRECTOR_REFERENCE_INVALID",
      path: `${path}.activeMotionClipId`,
      message: "the active motion clip is not in the object's clip list",
    });
}

function objectIssues(
  object: DirectorObject,
  index: number,
  issues: DirectorIssue[],
): void {
  const path = `objects[${index}]`;
  if (typeof object.id !== "string" || object.id === "")
    issues.push({
      code: "DIRECTOR_REFERENCE_INVALID",
      path: `${path}.id`,
      message: "an object needs an id",
    });
  if (
    typeof object.name !== "string" ||
    object.name.length > DIRECTOR_LIMITS.maxNameLength
  )
    issues.push({
      code: "VALIDATION_FAILED",
      path: `${path}.name`,
      message: `a name is at most ${DIRECTOR_LIMITS.maxNameLength} characters`,
    });
  if (!oneOf(DIRECTOR_OBJECT_KINDS, object.kind))
    issues.push({
      code: "VALIDATION_FAILED",
      path: `${path}.kind`,
      message: `"${object.kind}" is not an object kind`,
    });
  transformIssues(object.transform, `${path}.transform`, issues);
  if (!hexColor(object.color))
    issues.push({
      code: "VALIDATION_FAILED",
      path: `${path}.color`,
      message: "a colour is #rrggbb in lower case",
    });
  keyframeIssues(object.keyframes, `${path}.keyframes`, issues);

  const actorFields = {
    pose: object.pose !== undefined,
    archetype: object.archetype !== undefined,
    actorBuild: object.actorBuild !== undefined,
    animalBuild: object.animalBuild !== undefined,
    boneOverrides: object.boneOverrides !== undefined,
    boneTracks: object.boneTracks !== undefined,
  };

  switch (object.kind) {
    case "solid":
      if (!oneOf(DIRECTOR_SOLID_SHAPES, object.shape))
        issues.push({
          code: "VALIDATION_FAILED",
          path: `${path}.shape`,
          message: "a solid needs a known shape",
        });
      for (const [field, present] of Object.entries(actorFields)) {
        if (present)
          issues.push({
            code: "VALIDATION_FAILED",
            path: `${path}.${field}`,
            message: `a solid may not carry ${field}`,
          });
      }
      if (object.rig || object.motionClips || object.assetId)
        issues.push({
          code: "VALIDATION_FAILED",
          path,
          message: "a solid carries neither an asset nor a rig",
        });
      break;
    case "plate":
      if (!object.assetId)
        issues.push({
          code: "DIRECTOR_REFERENCE_INVALID",
          path: `${path}.assetId`,
          message: "a plate needs an image asset",
        });
      for (const [field, present] of Object.entries(actorFields)) {
        if (present)
          issues.push({
            code: "VALIDATION_FAILED",
            path: `${path}.${field}`,
            message: `a plate may not carry ${field}`,
          });
      }
      if (object.rig || object.motionClips)
        issues.push({
          code: "VALIDATION_FAILED",
          path,
          message: "a plate carries no rig",
        });
      break;
    case "model":
      if (!object.assetId)
        issues.push({
          code: "DIRECTOR_REFERENCE_INVALID",
          path: `${path}.assetId`,
          message: "a model needs a model asset",
        });
      for (const [field, present] of Object.entries(actorFields)) {
        if (present)
          issues.push({
            code: "VALIDATION_FAILED",
            path: `${path}.${field}`,
            message: `a model may not carry ${field}; use a performer for a rig`,
          });
      }
      rigIssues(object.rig, issues, path);
      motionIssues(object, issues, path);
      break;
    case "performer": {
      if (
        !isHumanoidArchetype(object.archetype) &&
        !isAnimalArchetype(object.archetype)
      )
        issues.push({
          code: "VALIDATION_FAILED",
          path: `${path}.archetype`,
          message: "a performer needs a humanoid or animal archetype",
        });
      if (object.archetype) {
        const form = actorFormFor(object.archetype);
        if (object.pose !== undefined && !oneOf(posesFor(form), object.pose))
          issues.push({
            code: "DIRECTOR_REFERENCE_INVALID",
            path: `${path}.pose`,
            message: `pose "${object.pose}" is not one this form offers`,
          });
        if (form === "humanoid" && object.animalBuild)
          issues.push({
            code: "VALIDATION_FAILED",
            path: `${path}.animalBuild`,
            message: "a humanoid may not carry an animal build",
          });
        if (form === "quadruped" && object.actorBuild)
          issues.push({
            code: "VALIDATION_FAILED",
            path: `${path}.actorBuild`,
            message: "a quadruped may not carry an actor build",
          });
        if (form === "humanoid" && !object.actorBuild && !object.assetId)
          issues.push({
            code: "DIRECTOR_REFERENCE_INVALID",
            path: `${path}.actorBuild`,
            message: "a procedural humanoid needs an actor build",
          });
        if (form === "quadruped" && !object.animalBuild)
          issues.push({
            code: "DIRECTOR_REFERENCE_INVALID",
            path: `${path}.animalBuild`,
            message: "a quadruped needs an animal build",
          });
        if (object.actorBuild) {
          const build = object.actorBuild;
          if (
            !finite(build.stature) ||
            build.stature < 0.5 ||
            build.stature > 2.5 ||
            !finite(build.headScale) ||
            build.headScale < 0.5 ||
            build.headScale > 2 ||
            !finite(build.shoulderSpan) ||
            build.shoulderSpan < 0.1 ||
            build.shoulderSpan > 1.2 ||
            !finite(build.torsoShare) ||
            build.torsoShare < 0.25 ||
            build.torsoShare > 0.4 ||
            !oneOf(DIRECTOR_ACCESSORIES, build.accessory)
          )
            issues.push({
              code: "VALIDATION_FAILED",
              path: `${path}.actorBuild`,
              message: "the actor build is outside its ranges",
            });
        }
        if (object.animalBuild) {
          const build = object.animalBuild;
          if (
            !finite(build.shoulderHeight) ||
            build.shoulderHeight < 0.15 ||
            build.shoulderHeight > 2.5 ||
            !finite(build.bodyLength) ||
            build.bodyLength < 0.2 ||
            build.bodyLength > 4 ||
            !finite(build.bodyWidth) ||
            build.bodyWidth < 0.05 ||
            build.bodyWidth > 1.2 ||
            !finite(build.headScale) ||
            build.headScale < 0.5 ||
            build.headScale > 2
          )
            issues.push({
              code: "VALIDATION_FAILED",
              path: `${path}.animalBuild`,
              message: "the animal build is outside its ranges",
            });
        }
        boneTrackIssues(object, form, issues, path);
      }
      rigIssues(object.rig, issues, path);
      motionIssues(object, issues, path);
      break;
    }
  }
}

/**
 * Everything wrong with a scene, as paths a reader can act on.
 *
 * The same list is read by the decoder (which refuses the document), the
 * command layer (which refuses the edit), and the editor (which shows it
 * before an output is made). A scene that passes here can be drawn.
 */
export function directorSceneIssues(
  scene: DirectorScene,
  options: { bytes?: number } = {},
): DirectorIssue[] {
  const issues: DirectorIssue[] = [];
  if (scene.schemaVersion !== DIRECTOR_SCHEMA_VERSION)
    issues.push({
      code: "DIRECTOR_SCHEMA_UNSUPPORTED",
      path: "schemaVersion",
      message: `scene version ${scene.schemaVersion} is not supported`,
    });
  if (
    typeof scene.title !== "string" ||
    scene.title.length > DIRECTOR_LIMITS.maxNameLength
  )
    issues.push({
      code: "VALIDATION_FAILED",
      path: "title",
      message: `a scene title is at most ${DIRECTOR_LIMITS.maxNameLength} characters`,
    });
  if (!hexColor(scene.background))
    issues.push({
      code: "VALIDATION_FAILED",
      path: "background",
      message: "the background is #rrggbb in lower case",
    });
  if (!finite(scene.environmentIntensity) || scene.environmentIntensity < 0)
    issues.push({
      code: "VALIDATION_FAILED",
      path: "environmentIntensity",
      message:
        "the environment intensity must be a finite, non-negative number",
    });
  if (
    options.bytes !== undefined &&
    options.bytes > DIRECTOR_LIMITS.maxSceneBytes
  )
    issues.push({
      code: "DIRECTOR_SCENE_TOO_LARGE",
      path: "scene",
      message: `the scene is ${options.bytes} bytes; the limit is ${DIRECTOR_LIMITS.maxSceneBytes}`,
    });

  if (scene.environment) {
    const environment = scene.environment;
    if (environment.mode !== "color" && environment.mode !== "panorama")
      issues.push({
        code: "VALIDATION_FAILED",
        path: "environment.mode",
        message: "the environment is colour or panorama",
      });
    if (environment.mode === "panorama" && !environment.assetId)
      issues.push({
        code: "DIRECTOR_REFERENCE_INVALID",
        path: "environment.assetId",
        message: "a panorama needs an image asset",
      });
    for (const [field, value] of [
      ["rotationY", environment.rotationY],
      ["exposure", environment.exposure],
      ["lightingIntensity", environment.lightingIntensity],
    ] as const) {
      if (value !== undefined && !finite(value))
        issues.push({
          code: "VALIDATION_FAILED",
          path: `environment.${field}`,
          message: `environment.${field} must be finite`,
        });
    }
  }

  if (scene.objects.length > DIRECTOR_LIMITS.maxObjectsPerScene)
    issues.push({
      code: "DIRECTOR_LIMIT_EXCEEDED",
      path: "objects",
      message: `a scene holds at most ${DIRECTOR_LIMITS.maxObjectsPerScene} objects`,
    });
  if (scene.cameras.length > DIRECTOR_LIMITS.maxCamerasPerScene)
    issues.push({
      code: "DIRECTOR_LIMIT_EXCEEDED",
      path: "cameras",
      message: `a scene holds at most ${DIRECTOR_LIMITS.maxCamerasPerScene} cameras`,
    });
  if (scene.lights.length > DIRECTOR_LIMITS.maxLightsPerScene)
    issues.push({
      code: "DIRECTOR_LIMIT_EXCEEDED",
      path: "lights",
      message: `a scene holds at most ${DIRECTOR_LIMITS.maxLightsPerScene} lights`,
    });
  if (scene.shots.length > DIRECTOR_LIMITS.maxShotsPerScene)
    issues.push({
      code: "DIRECTOR_LIMIT_EXCEEDED",
      path: "shots",
      message: `a scene holds at most ${DIRECTOR_LIMITS.maxShotsPerScene} shots`,
    });
  if (scene.shots.length === 0)
    issues.push({
      code: "DIRECTOR_REFERENCE_INVALID",
      path: "shots",
      message: "a scene needs at least one shot",
    });
  if (scene.cameras.length === 0)
    issues.push({
      code: "DIRECTOR_REFERENCE_INVALID",
      path: "cameras",
      message: "a scene needs at least one camera",
    });

  const ids = new Set<string>();
  const noticeId = (id: string, path: string) => {
    if (typeof id !== "string" || id === "")
      issues.push({
        code: "DIRECTOR_REFERENCE_INVALID",
        path,
        message: "an id is required",
      });
    else if (ids.has(id))
      issues.push({
        code: "DIRECTOR_REFERENCE_INVALID",
        path,
        message: `id "${id}" is used more than once in the scene`,
      });
    else ids.add(id);
  };

  scene.objects.forEach((object, index) => {
    noticeId(object.id, `objects[${index}].id`);
    objectIssues(object, index, issues);
  });

  const cameraIds = new Set<string>();
  scene.cameras.forEach((camera, index) => {
    const path = `cameras[${index}]`;
    noticeId(camera.id, `${path}.id`);
    cameraIds.add(camera.id);
    if (
      typeof camera.name !== "string" ||
      camera.name.length > DIRECTOR_LIMITS.maxNameLength
    )
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.name`,
        message: `a name is at most ${DIRECTOR_LIMITS.maxNameLength} characters`,
      });
    transformIssues(camera.transform, `${path}.transform`, issues);
    if (!vec3(camera.target))
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.target`,
        message: "a camera target is three finite numbers",
      });
    if (
      !finite(camera.focalLength) ||
      camera.focalLength < 12 ||
      camera.focalLength > 300
    )
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.focalLength`,
        message: "the focal length is between 12 and 300 mm",
      });
    if (
      !finite(camera.aperture) ||
      camera.aperture < 1.2 ||
      camera.aperture > 22
    )
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.aperture`,
        message: "the aperture is between f/1.2 and f/22",
      });
    if (
      !finite(camera.focusDistance) ||
      camera.focusDistance < 0.1 ||
      camera.focusDistance > 1000
    )
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.focusDistance`,
        message: "the focus distance is between 0.1 and 1000 m",
      });
    if (!finite(camera.near) || camera.near <= 0)
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.near`,
        message: "the near plane is positive",
      });
    if (!finite(camera.far) || camera.far <= camera.near)
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.far`,
        message: "the far plane is behind the near plane",
      });
    if (camera.transform.scale?.some((axis) => axis !== 1))
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.transform.scale`,
        message: "a camera's scale is always one",
      });
    keyframeIssues(camera.keyframes, `${path}.keyframes`, issues);
  });

  scene.lights.forEach((light, index) => {
    const path = `lights[${index}]`;
    noticeId(light.id, `${path}.id`);
    if (!oneOf(DIRECTOR_LIGHT_TYPES, light.type))
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.type`,
        message: `"${light.type}" is not a light type`,
      });
    transformIssues(light.transform, `${path}.transform`, issues);
    if (!hexColor(light.color))
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.color`,
        message: "a colour is #rrggbb in lower case",
      });
    if (
      !finite(light.intensity) ||
      light.intensity < 0 ||
      light.intensity > 100
    )
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.intensity`,
        message: "the intensity is between 0 and 100",
      });
    if (light.type === "spot") {
      if (
        light.angle !== undefined &&
        (!finite(light.angle) || light.angle <= 0 || light.angle > Math.PI / 2)
      )
        issues.push({
          code: "VALIDATION_FAILED",
          path: `${path}.angle`,
          message: "a spot angle is between 0 and 90 degrees",
        });
      if (
        light.penumbra !== undefined &&
        (!finite(light.penumbra) || light.penumbra < 0 || light.penumbra > 1)
      )
        issues.push({
          code: "VALIDATION_FAILED",
          path: `${path}.penumbra`,
          message: "a spot penumbra is between 0 and 1",
        });
    }
  });

  scene.shots.forEach((shot, index) => {
    const path = `shots[${index}]`;
    noticeId(shot.id, `${path}.id`);
    if (
      typeof shot.name !== "string" ||
      shot.name.length > DIRECTOR_LIMITS.maxNameLength
    )
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.name`,
        message: `a name is at most ${DIRECTOR_LIMITS.maxNameLength} characters`,
      });
    if (!cameraIds.has(shot.cameraId))
      issues.push({
        code: "DIRECTOR_REFERENCE_INVALID",
        path: `${path}.cameraId`,
        message: "the shot's camera is not in the scene",
      });
    if (!finite(shot.duration) || shot.duration < 0.5 || shot.duration > 60)
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.duration`,
        message: "a shot runs between 0.5 and 60 seconds",
      });
    if (!(DIRECTOR_SHOT_FPS as readonly number[]).includes(shot.fps))
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.fps`,
        message: "a shot runs at 24, 25, or 30 frames a second",
      });
    if (!oneOf(DIRECTOR_ASPECT_RATIOS, shot.aspectRatio))
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.aspectRatio`,
        message: `"${shot.aspectRatio}" is not a shot ratio`,
      });
    if (!oneOf(DIRECTOR_SHOT_SIZES, shot.shotSize))
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.shotSize`,
        message: `"${shot.shotSize}" is not a shot size`,
      });
    if (!oneOf(DIRECTOR_CAMERA_MOVES, shot.cameraMove))
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.cameraMove`,
        message: `"${shot.cameraMove}" is not a camera move`,
      });
    if (
      typeof shot.prompt !== "string" ||
      shot.prompt.length > DIRECTOR_LIMITS.maxPromptLength
    )
      issues.push({
        code: "VALIDATION_FAILED",
        path: `${path}.prompt`,
        message: `a prompt is at most ${DIRECTOR_LIMITS.maxPromptLength} characters`,
      });
  });

  if (!scene.shots.some((shot) => shot.id === scene.activeShotId))
    issues.push({
      code: "DIRECTOR_REFERENCE_INVALID",
      path: "activeShotId",
      message: "the active shot is not in the scene",
    });

  return issues;
}

/** True when nothing in the scene needs repairing. */
export function directorSceneValid(scene: DirectorScene): boolean {
  return directorSceneIssues(scene).length === 0;
}

/**
 * Reads the active shot, falling back to the first one the way a decoder does.
 *
 * A scene with no shots has none to fall back to; the caller decides what an
 * empty scene means rather than being handed an invented shot.
 */
export function activeShotOf(scene: DirectorScene): DirectorShot | undefined {
  return (
    scene.shots.find((shot) => shot.id === scene.activeShotId) ?? scene.shots[0]
  );
}

/** The camera a shot looks through, if it is still there. */
export function shotCamera(
  scene: DirectorScene,
  shot: DirectorShot,
): DirectorCamera | undefined {
  return scene.cameras.find((camera) => camera.id === shot.cameraId);
}

/**
 * Every project file a scene reads: its panorama and the material of each
 * model or plate. Outputs delivered from the scene belong to its card and are
 * collected separately.
 */
export function directorSceneAssetIds(scene: DirectorScene): AssetId[] {
  const seen = new Set<AssetId>();
  if (scene.environment?.assetId) seen.add(scene.environment.assetId);
  for (const object of scene.objects) {
    if (object.assetId) seen.add(object.assetId);
  }
  return [...seen];
}
