import { Double, serialize } from "bson";
import {
  DIRECTOR_ACCESSORIES,
  DIRECTOR_ANIMAL_POSES,
  DIRECTOR_ASPECT_RATIOS,
  DIRECTOR_CAMERA_MOVES,
  DIRECTOR_EASINGS,
  DIRECTOR_HUMANOID_POSES,
  DIRECTOR_LIGHT_TYPES,
  DIRECTOR_OBJECT_KINDS,
  DIRECTOR_SCHEMA_VERSION,
  DIRECTOR_SHOT_SIZES,
  DIRECTOR_SOLID_SHAPES,
  DIRECTOR_ARCHETYPES,
  directorSceneIssues,
  type DirectorActorArchetype,
  type DirectorActorBuild,
  type DirectorAnimalBuild,
  type DirectorBone,
  type DirectorBoneKeyframe,
  type DirectorBoneTrack,
  type DirectorCamera,
  type DirectorEnvironment,
  type DirectorKeyframe,
  type DirectorLight,
  type DirectorMotionClip,
  type DirectorObject,
  type DirectorQuat,
  type DirectorRig,
  type DirectorScene,
  type DirectorShot,
  type DirectorState,
  type DirectorTransform,
  type DirectorVec3,
} from "./director";
import { MokaCodecError } from "./codecError";

const n = (value: number): Double => new Double(value);

function encodeVec3(value: DirectorVec3): Double[] {
  return value.map(n);
}

function encodeQuat(value: DirectorQuat): Double[] {
  return value.map(n);
}

function encodeTransform(transform: DirectorTransform) {
  return {
    position: encodeVec3(transform.position),
    rotation: encodeVec3(transform.rotation),
    scale: encodeVec3(transform.scale),
  };
}

function encodeKeyframe(keyframe: DirectorKeyframe): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: keyframe.id,
    time: n(keyframe.time),
    transform: encodeTransform(keyframe.transform),
  };
  if (keyframe.easing !== undefined) doc.easing = keyframe.easing;
  return doc;
}

function encodeBoneKeyframe(
  keyframe: DirectorBoneKeyframe,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: keyframe.id,
    time: n(keyframe.time),
    rotation: encodeQuat(keyframe.rotation),
  };
  if (keyframe.easing !== undefined) doc.easing = keyframe.easing;
  return doc;
}

function encodeBoneTrack(track: DirectorBoneTrack): Record<string, unknown> {
  return {
    bone: track.bone,
    keyframes: track.keyframes.map(encodeBoneKeyframe),
  };
}

function encodeActorBuild(build: DirectorActorBuild) {
  return {
    stature: n(build.stature),
    headScale: n(build.headScale),
    shoulderSpan: n(build.shoulderSpan),
    torsoShare: n(build.torsoShare),
    accessory: build.accessory,
  };
}

function encodeAnimalBuild(build: DirectorAnimalBuild) {
  return {
    shoulderHeight: n(build.shoulderHeight),
    bodyLength: n(build.bodyLength),
    bodyWidth: n(build.bodyWidth),
    headScale: n(build.headScale),
  };
}

/** A map written in key order, as the Rust BTreeMap writes it. */
function sortedRecord<T>(
  entries: Record<string, T>,
  value: (entry: T) => unknown,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(entries)
      .sort()
      .map((key) => [key, value(entries[key])]),
  );
}

function encodeRig(rig: DirectorRig) {
  return {
    status: rig.status,
    boneMap: sortedRecord(rig.boneMap, (name) => name),
    animationNames: [...rig.animationNames],
  };
}

function encodeMotionClip(clip: DirectorMotionClip) {
  return {
    id: clip.id,
    name: clip.name,
    sourceAnimation: clip.sourceAnimation,
    start: n(clip.start),
    duration: n(clip.duration),
    playbackRate: n(clip.playbackRate),
    loop: clip.loop,
  };
}

function encodeObject(object: DirectorObject): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: object.id,
    name: object.name,
    kind: object.kind,
  };
  if (object.shape !== undefined) doc.shape = object.shape;
  doc.transform = encodeTransform(object.transform);
  doc.color = object.color;
  doc.visible = object.visible;
  doc.castShadow = object.castShadow;
  doc.receiveShadow = object.receiveShadow;
  if (object.pose !== undefined) doc.pose = object.pose;
  if (object.archetype !== undefined) doc.archetype = object.archetype;
  if (object.actorBuild !== undefined)
    doc.actorBuild = encodeActorBuild(object.actorBuild);
  if (object.animalBuild !== undefined)
    doc.animalBuild = encodeAnimalBuild(object.animalBuild);
  if (object.rig !== undefined) doc.rig = encodeRig(object.rig);
  if (object.motionClips !== undefined)
    doc.motionClips = object.motionClips.map(encodeMotionClip);
  if (object.activeMotionClipId !== undefined)
    doc.activeMotionClipId = object.activeMotionClipId;
  if (object.boneOverrides !== undefined)
    doc.boneOverrides = sortedRecord(object.boneOverrides, (rotation) =>
      encodeQuat(rotation),
    );
  if (object.boneTracks !== undefined)
    doc.boneTracks = object.boneTracks.map(encodeBoneTrack);
  if (object.assetId !== undefined) doc.assetId = object.assetId;
  if (object.sourceNodeId !== undefined) doc.sourceNodeId = object.sourceNodeId;
  doc.keyframes = object.keyframes.map(encodeKeyframe);
  return doc;
}

function encodeCamera(camera: DirectorCamera): Record<string, unknown> {
  return {
    id: camera.id,
    name: camera.name,
    transform: encodeTransform(camera.transform),
    target: encodeVec3(camera.target),
    focalLength: n(camera.focalLength),
    aperture: n(camera.aperture),
    focusDistance: n(camera.focusDistance),
    near: n(camera.near),
    far: n(camera.far),
    keyframes: camera.keyframes.map(encodeKeyframe),
  };
}

function encodeLight(light: DirectorLight): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: light.id,
    name: light.name,
    type: light.type,
    transform: encodeTransform(light.transform),
    color: light.color,
    intensity: n(light.intensity),
  };
  if (light.angle !== undefined) doc.angle = n(light.angle);
  if (light.penumbra !== undefined) doc.penumbra = n(light.penumbra);
  doc.castShadow = light.castShadow;
  return doc;
}

function encodeShot(shot: DirectorShot): Record<string, unknown> {
  return {
    id: shot.id,
    name: shot.name,
    cameraId: shot.cameraId,
    duration: n(shot.duration),
    fps: shot.fps,
    aspectRatio: shot.aspectRatio,
    shotSize: shot.shotSize,
    cameraMove: shot.cameraMove,
    prompt: shot.prompt,
  };
}

function encodeEnvironment(
  environment: DirectorEnvironment,
): Record<string, unknown> {
  const doc: Record<string, unknown> = { mode: environment.mode };
  if (environment.assetId !== undefined) doc.assetId = environment.assetId;
  if (environment.rotationY !== undefined)
    doc.rotationY = n(environment.rotationY);
  if (environment.exposure !== undefined)
    doc.exposure = n(environment.exposure);
  if (environment.useAsLighting !== undefined)
    doc.useAsLighting = environment.useAsLighting;
  if (environment.lightingIntensity !== undefined)
    doc.lightingIntensity = n(environment.lightingIntensity);
  return doc;
}

/** A scene as the document writes it: field order is the Rust declaration order. */
export function encodeDirectorScene(
  scene: DirectorScene,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: scene.id,
    schemaVersion: scene.schemaVersion,
    title: scene.title,
    background: scene.background,
    environmentIntensity: n(scene.environmentIntensity),
  };
  if (scene.environment !== undefined)
    doc.environment = encodeEnvironment(scene.environment);
  doc.gridVisible = scene.gridVisible;
  doc.objects = scene.objects.map(encodeObject);
  doc.cameras = scene.cameras.map(encodeCamera);
  doc.lights = scene.lights.map(encodeLight);
  doc.shots = scene.shots.map(encodeShot);
  doc.activeShotId = scene.activeShotId;
  doc.createdAt = scene.createdAt;
  doc.updatedAt = scene.updatedAt;
  return doc;
}

export function encodeDirectorState(
  state: DirectorState,
): Record<string, unknown> {
  const doc: Record<string, unknown> = { sceneId: state.sceneId };
  if (state.frameAssetId !== undefined) doc.frameAssetId = state.frameAssetId;
  if (state.blockingAssetId !== undefined)
    doc.blockingAssetId = state.blockingAssetId;
  if (state.frameShotId !== undefined) doc.frameShotId = state.frameShotId;
  if (state.directionText !== undefined)
    doc.directionText = state.directionText;
  if (state.deliveredAt !== undefined) doc.deliveredAt = state.deliveredAt;
  return doc;
}

/** The scene's BSON size, which is what the scene limit is stated in. */
export function directorSceneBytes(scene: DirectorScene): number {
  return serialize(encodeDirectorScene(scene)).length;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function fail(path: string, why: string, code = "MOKA_BSON_INVALID"): never {
  throw new MokaCodecError(code, `canvas.moka director scene ${path} ${why}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(path, "must be an object");
  return value as Record<string, unknown>;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be a list");
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "must be a string");
  return value;
}

function optionalText(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, path);
}

function number(value: unknown, path: string): number {
  const read =
    typeof value === "number"
      ? value
      : value instanceof Double
        ? value.valueOf()
        : undefined;
  if (read === undefined || !Number.isFinite(read))
    fail(path, "must be a finite number");
  return read;
}

function integer(value: unknown, path: string): number {
  const read = number(value, path);
  if (!Number.isInteger(read)) fail(path, "must be a whole number");
  return read;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
  path: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T))
    fail(path, `"${String(value)}" is not one this build reads`);
  return value as T;
}

function vec3(value: unknown, path: string): DirectorVec3 {
  const entries = list(value, path);
  if (entries.length !== 3) fail(path, "must hold three numbers");
  return entries.map((entry, index) =>
    number(entry, `${path}[${index}]`),
  ) as DirectorVec3;
}

function quat(value: unknown, path: string): DirectorQuat {
  const entries = list(value, path);
  if (entries.length !== 4) fail(path, "must hold four numbers");
  return entries.map((entry, index) =>
    number(entry, `${path}[${index}]`),
  ) as DirectorQuat;
}

function decodeTransform(value: unknown, path: string): DirectorTransform {
  const doc = record(value, path);
  return {
    position: vec3(doc.position, `${path}.position`),
    rotation: vec3(doc.rotation, `${path}.rotation`),
    scale: vec3(doc.scale, `${path}.scale`),
  };
}

function decodeKeyframe(value: unknown, path: string): DirectorKeyframe {
  const doc = record(value, path);
  const keyframe: DirectorKeyframe = {
    id: text(doc.id, `${path}.id`),
    time: number(doc.time, `${path}.time`),
    transform: decodeTransform(doc.transform, `${path}.transform`),
  };
  if (doc.easing !== undefined)
    keyframe.easing = oneOf(DIRECTOR_EASINGS, doc.easing, `${path}.easing`);
  return keyframe;
}

function decodeBoneKeyframe(
  value: unknown,
  path: string,
): DirectorBoneKeyframe {
  const doc = record(value, path);
  const keyframe: DirectorBoneKeyframe = {
    id: text(doc.id, `${path}.id`),
    time: number(doc.time, `${path}.time`),
    rotation: quat(doc.rotation, `${path}.rotation`),
  };
  if (doc.easing !== undefined)
    keyframe.easing = oneOf(DIRECTOR_EASINGS, doc.easing, `${path}.easing`);
  return keyframe;
}

function decodeBoneTrack(value: unknown, path: string): DirectorBoneTrack {
  const doc = record(value, path);
  return {
    bone: text(doc.bone, `${path}.bone`) as DirectorBone,
    keyframes: list(doc.keyframes, `${path}.keyframes`).map((entry, index) =>
      decodeBoneKeyframe(entry, `${path}.keyframes[${index}]`),
    ),
  };
}

function decodeActorBuild(value: unknown, path: string): DirectorActorBuild {
  const doc = record(value, path);
  return {
    stature: number(doc.stature, `${path}.stature`),
    headScale: number(doc.headScale, `${path}.headScale`),
    shoulderSpan: number(doc.shoulderSpan, `${path}.shoulderSpan`),
    torsoShare: number(doc.torsoShare, `${path}.torsoShare`),
    accessory: oneOf(DIRECTOR_ACCESSORIES, doc.accessory, `${path}.accessory`),
  };
}

function decodeAnimalBuild(value: unknown, path: string): DirectorAnimalBuild {
  const doc = record(value, path);
  return {
    shoulderHeight: number(doc.shoulderHeight, `${path}.shoulderHeight`),
    bodyLength: number(doc.bodyLength, `${path}.bodyLength`),
    bodyWidth: number(doc.bodyWidth, `${path}.bodyWidth`),
    headScale: number(doc.headScale, `${path}.headScale`),
  };
}

function decodeRig(value: unknown, path: string): DirectorRig {
  const doc = record(value, path);
  const status = doc.status;
  if (status !== "unmapped" && status !== "ready")
    fail(`${path}.status`, "must be unmapped or ready");
  const boneMapDoc = record(doc.boneMap, `${path}.boneMap`);
  const boneMap: DirectorRig["boneMap"] = {};
  for (const [bone, name] of Object.entries(boneMapDoc)) {
    const mapped = text(name, `${path}.boneMap.${bone}`);
    boneMap[bone as keyof DirectorRig["boneMap"]] = mapped;
  }
  return {
    status,
    boneMap,
    animationNames: list(doc.animationNames, `${path}.animationNames`).map(
      (name, index) => text(name, `${path}.animationNames[${index}]`),
    ),
  };
}

function decodeMotionClip(value: unknown, path: string): DirectorMotionClip {
  const doc = record(value, path);
  return {
    id: text(doc.id, `${path}.id`),
    name: text(doc.name, `${path}.name`),
    sourceAnimation: text(doc.sourceAnimation, `${path}.sourceAnimation`),
    start: number(doc.start, `${path}.start`),
    duration: number(doc.duration, `${path}.duration`),
    playbackRate: number(doc.playbackRate, `${path}.playbackRate`),
    loop: bool(doc.loop, `${path}.loop`),
  };
}

function decodeObject(value: unknown, path: string): DirectorObject {
  const doc = record(value, path);
  const object: DirectorObject = {
    id: text(doc.id, `${path}.id`),
    name: text(doc.name, `${path}.name`),
    kind: oneOf(DIRECTOR_OBJECT_KINDS, doc.kind, `${path}.kind`),
    transform: decodeTransform(doc.transform, `${path}.transform`),
    color: text(doc.color, `${path}.color`),
    visible: bool(doc.visible, `${path}.visible`),
    castShadow: bool(doc.castShadow, `${path}.castShadow`),
    receiveShadow: bool(doc.receiveShadow, `${path}.receiveShadow`),
    keyframes: list(doc.keyframes, `${path}.keyframes`).map((entry, index) =>
      decodeKeyframe(entry, `${path}.keyframes[${index}]`),
    ),
  };
  if (doc.shape !== undefined)
    object.shape = oneOf(DIRECTOR_SOLID_SHAPES, doc.shape, `${path}.shape`);
  if (doc.pose !== undefined) {
    const pose = text(doc.pose, `${path}.pose`);
    if (
      !DIRECTOR_HUMANOID_POSES.includes(pose as never) &&
      !DIRECTOR_ANIMAL_POSES.includes(pose as never)
    )
      fail(`${path}.pose`, `"${pose}" is not a pose this build reads`);
    object.pose = pose as DirectorObject["pose"];
  }
  if (doc.archetype !== undefined)
    object.archetype = oneOf(
      DIRECTOR_ARCHETYPES,
      doc.archetype,
      `${path}.archetype`,
    ) as DirectorActorArchetype;
  if (doc.actorBuild !== undefined)
    object.actorBuild = decodeActorBuild(doc.actorBuild, `${path}.actorBuild`);
  if (doc.animalBuild !== undefined)
    object.animalBuild = decodeAnimalBuild(
      doc.animalBuild,
      `${path}.animalBuild`,
    );
  if (doc.rig !== undefined) object.rig = decodeRig(doc.rig, `${path}.rig`);
  if (doc.motionClips !== undefined)
    object.motionClips = list(doc.motionClips, `${path}.motionClips`).map(
      (entry, index) =>
        decodeMotionClip(entry, `${path}.motionClips[${index}]`),
    );
  if (doc.activeMotionClipId !== undefined)
    object.activeMotionClipId = text(
      doc.activeMotionClipId,
      `${path}.activeMotionClipId`,
    );
  if (doc.boneOverrides !== undefined) {
    const overrides = record(doc.boneOverrides, `${path}.boneOverrides`);
    const boneOverrides: DirectorObject["boneOverrides"] = {};
    for (const [bone, rotation] of Object.entries(overrides)) {
      boneOverrides[bone as DirectorBone] = quat(
        rotation,
        `${path}.boneOverrides.${bone}`,
      );
    }
    object.boneOverrides = boneOverrides;
  }
  if (doc.boneTracks !== undefined)
    object.boneTracks = list(doc.boneTracks, `${path}.boneTracks`).map(
      (entry, index) => decodeBoneTrack(entry, `${path}.boneTracks[${index}]`),
    );
  if (doc.assetId !== undefined)
    object.assetId = text(doc.assetId, `${path}.assetId`);
  if (doc.sourceNodeId !== undefined)
    object.sourceNodeId = text(doc.sourceNodeId, `${path}.sourceNodeId`);
  return object;
}

function decodeCamera(value: unknown, path: string): DirectorCamera {
  const doc = record(value, path);
  return {
    id: text(doc.id, `${path}.id`),
    name: text(doc.name, `${path}.name`),
    transform: decodeTransform(doc.transform, `${path}.transform`),
    target: vec3(doc.target, `${path}.target`),
    focalLength: number(doc.focalLength, `${path}.focalLength`),
    aperture: number(doc.aperture, `${path}.aperture`),
    focusDistance: number(doc.focusDistance, `${path}.focusDistance`),
    near: number(doc.near, `${path}.near`),
    far: number(doc.far, `${path}.far`),
    keyframes: list(doc.keyframes, `${path}.keyframes`).map((entry, index) =>
      decodeKeyframe(entry, `${path}.keyframes[${index}]`),
    ),
  };
}

function decodeLight(value: unknown, path: string): DirectorLight {
  const doc = record(value, path);
  const light: DirectorLight = {
    id: text(doc.id, `${path}.id`),
    name: text(doc.name, `${path}.name`),
    type: oneOf(DIRECTOR_LIGHT_TYPES, doc.type, `${path}.type`),
    transform: decodeTransform(doc.transform, `${path}.transform`),
    color: text(doc.color, `${path}.color`),
    intensity: number(doc.intensity, `${path}.intensity`),
    castShadow: bool(doc.castShadow, `${path}.castShadow`),
  };
  if (doc.angle !== undefined) light.angle = number(doc.angle, `${path}.angle`);
  if (doc.penumbra !== undefined)
    light.penumbra = number(doc.penumbra, `${path}.penumbra`);
  return light;
}

function decodeShot(value: unknown, path: string): DirectorShot {
  const doc = record(value, path);
  return {
    id: text(doc.id, `${path}.id`),
    name: text(doc.name, `${path}.name`),
    cameraId: text(doc.cameraId, `${path}.cameraId`),
    duration: number(doc.duration, `${path}.duration`),
    fps: integer(doc.fps, `${path}.fps`) as DirectorShot["fps"],
    aspectRatio: oneOf(
      DIRECTOR_ASPECT_RATIOS,
      doc.aspectRatio,
      `${path}.aspectRatio`,
    ),
    shotSize: oneOf(DIRECTOR_SHOT_SIZES, doc.shotSize, `${path}.shotSize`),
    cameraMove: oneOf(
      DIRECTOR_CAMERA_MOVES,
      doc.cameraMove,
      `${path}.cameraMove`,
    ),
    prompt: text(doc.prompt, `${path}.prompt`),
  };
}

function decodeEnvironment(value: unknown, path: string): DirectorEnvironment {
  const doc = record(value, path);
  const mode = doc.mode;
  if (mode !== "color" && mode !== "panorama")
    fail(`${path}.mode`, "must be color or panorama");
  const environment: DirectorEnvironment = { mode };
  if (doc.assetId !== undefined)
    environment.assetId = text(doc.assetId, `${path}.assetId`);
  if (doc.rotationY !== undefined)
    environment.rotationY = number(doc.rotationY, `${path}.rotationY`);
  if (doc.exposure !== undefined)
    environment.exposure = number(doc.exposure, `${path}.exposure`);
  if (doc.useAsLighting !== undefined)
    environment.useAsLighting = bool(
      doc.useAsLighting,
      `${path}.useAsLighting`,
    );
  if (doc.lightingIntensity !== undefined)
    environment.lightingIntensity = number(
      doc.lightingIntensity,
      `${path}.lightingIntensity`,
    );
  return environment;
}

/**
 * One scene, read strictly.
 *
 * The decoder does not repair: a scene with an unknown pose, a shot pointing
 * at a missing camera, or a humanoid wearing quadruped bones is refused whole
 * and the project's open reports where. An empty shot list has nothing to
 * fall back to; a missing active shot falls back to the first, the way the
 * plan says a decoder may.
 */
export function decodeDirectorScene(value: unknown): DirectorScene {
  const doc = record(value, "scene");
  const shots = list(doc.shots, "shots").map((entry, index) =>
    decodeShot(entry, `shots[${index}]`),
  );
  if (shots.length === 0) fail("shots", "must hold at least one shot");
  const requestedActive = optionalText(doc.activeShotId, "activeShotId");
  const activeShotId =
    requestedActive && shots.some((shot) => shot.id === requestedActive)
      ? requestedActive
      : shots[0].id;
  const scene: DirectorScene = {
    id: text(doc.id, "id"),
    schemaVersion: integer(
      doc.schemaVersion,
      "schemaVersion",
    ) as DirectorScene["schemaVersion"],
    title: text(doc.title, "title"),
    background: text(doc.background, "background"),
    environmentIntensity: number(
      doc.environmentIntensity,
      "environmentIntensity",
    ),
    gridVisible: bool(doc.gridVisible, "gridVisible"),
    objects: list(doc.objects, "objects").map((entry, index) =>
      decodeObject(entry, `objects[${index}]`),
    ),
    cameras: list(doc.cameras, "cameras").map((entry, index) =>
      decodeCamera(entry, `cameras[${index}]`),
    ),
    lights: list(doc.lights, "lights").map((entry, index) =>
      decodeLight(entry, `lights[${index}]`),
    ),
    shots,
    activeShotId,
    createdAt: text(doc.createdAt, "createdAt"),
    updatedAt: text(doc.updatedAt, "updatedAt"),
  };
  if (doc.environment !== undefined)
    scene.environment = decodeEnvironment(doc.environment, "environment");
  if (scene.schemaVersion !== DIRECTOR_SCHEMA_VERSION)
    fail(
      "schemaVersion",
      `version ${scene.schemaVersion} is not supported`,
      "DIRECTOR_SCHEMA_UNSUPPORTED",
    );
  const issues = directorSceneIssues(scene);
  if (issues.length > 0) {
    const first = issues[0];
    fail(first.path, `is invalid: ${first.message}`, first.code);
  }
  return scene;
}

export function decodeDirectorState(value: unknown): DirectorState {
  const doc = record(value, "director");
  const state: DirectorState = {
    sceneId: text(doc.sceneId, "director.sceneId"),
  };
  if (doc.frameAssetId !== undefined)
    state.frameAssetId = text(doc.frameAssetId, "director.frameAssetId");
  if (doc.blockingAssetId !== undefined)
    state.blockingAssetId = text(
      doc.blockingAssetId,
      "director.blockingAssetId",
    );
  if (doc.frameShotId !== undefined)
    state.frameShotId = text(doc.frameShotId, "director.frameShotId");
  if (doc.directionText !== undefined)
    state.directionText = text(doc.directionText, "director.directionText");
  if (doc.deliveredAt !== undefined)
    state.deliveredAt = text(doc.deliveredAt, "director.deliveredAt");
  return state;
}
