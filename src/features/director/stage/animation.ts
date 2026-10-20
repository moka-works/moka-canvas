import { Euler, Quaternion } from "three";
import {
  newId,
  type DirectorBone,
  type DirectorCamera,
  type DirectorBoneKeyframe,
  type DirectorCameraMove,
  type DirectorKeyframe,
  type DirectorQuat,
  type DirectorScene,
  type DirectorTransform,
} from "../../../shared/domain";
import { boneRotationOrIdentity } from "./poses";

/** Two keyframes closer than this are the same instant. */
export const KEY_TOLERANCE = 0.001;

/** The time written for a value meant for a frame boundary. */
export function snapTime(time: number, fps: number): number {
  if (!(fps > 0)) return Math.max(0, time);
  return Math.round(Math.max(0, time) * fps) / fps;
}

function sorted(frames: DirectorKeyframe[]): DirectorKeyframe[] {
  return [...frames].sort((a, b) => a.time - b.time);
}

function ease(kind: string | undefined, t: number): number {
  if (kind === "step") return 0;
  if (kind === "smooth") return t * t * (3 - 2 * t);
  return t;
}

function quatOf(rotation: [number, number, number]): Quaternion {
  return new Quaternion().setFromEuler(new Euler(...rotation));
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export function sampleTransform(
  frames: DirectorKeyframe[],
  time: number,
): DirectorTransform | undefined {
  if (frames.length === 0) return undefined;
  const ordered = sorted(frames);
  if (time <= ordered[0].time) return cloneTransform(ordered[0].transform);
  const last = ordered[ordered.length - 1];
  if (time >= last.time) return cloneTransform(last.transform);
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const from = ordered[index];
    const to = ordered[index + 1];
    if (time < from.time || time > to.time) continue;
    const span = to.time - from.time;
    const t = ease(from.easing, span <= 0 ? 1 : (time - from.time) / span);
    const rotation = quatOf(from.transform.rotation).slerp(
      quatOf(to.transform.rotation),
      t,
    );
    const euler = new Euler().setFromQuaternion(rotation);
    return {
      position: [
        lerp(from.transform.position[0], to.transform.position[0], t),
        lerp(from.transform.position[1], to.transform.position[1], t),
        lerp(from.transform.position[2], to.transform.position[2], t),
      ],
      rotation: [euler.x, euler.y, euler.z],
      scale: [
        lerp(from.transform.scale[0], to.transform.scale[0], t),
        lerp(from.transform.scale[1], to.transform.scale[1], t),
        lerp(from.transform.scale[2], to.transform.scale[2], t),
      ],
    };
  }
  return cloneTransform(last.transform);
}

export function cloneTransform(
  transform: DirectorTransform,
): DirectorTransform {
  return {
    position: [...transform.position],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  };
}

export function upsertTransformKeyframe(
  frames: DirectorKeyframe[],
  time: number,
  transform: DirectorTransform,
  easing?: DirectorKeyframe["easing"],
): DirectorKeyframe[] {
  const ordered = sorted(frames);
  const existing = ordered.findIndex(
    (frame) => Math.abs(frame.time - time) < KEY_TOLERANCE,
  );
  if (existing >= 0) {
    ordered[existing] = {
      ...ordered[existing],
      time,
      transform: cloneTransform(transform),
      ...(easing !== undefined ? { easing } : {}),
    };
    return sorted(ordered);
  }
  return sorted([
    ...ordered,
    {
      id: newId(),
      time,
      transform: cloneTransform(transform),
      ...(easing !== undefined ? { easing } : {}),
    },
  ]);
}

export function removeKeyframe(
  frames: DirectorKeyframe[],
  id: string,
): DirectorKeyframe[] {
  return frames.filter((frame) => frame.id !== id);
}

/**
 * The increment between two transforms, applied to a base and every keyframe.
 *
 * Turning AutoKey off on an animated object does not flatten the animation:
 * the reader moved the object at one moment, and every frame moves with it by
 * the same amount, so the shape of the movement is kept.
 */
function withDelta(
  transform: DirectorTransform,
  delta: {
    position: [number, number, number];
    rotation: Quaternion;
    scale: [number, number, number];
  },
): DirectorTransform {
  const rotation = quatOf(transform.rotation).premultiply(delta.rotation);
  const euler = new Euler().setFromQuaternion(rotation);
  return {
    position: [
      transform.position[0] + delta.position[0],
      transform.position[1] + delta.position[1],
      transform.position[2] + delta.position[2],
    ],
    rotation: [euler.x, euler.y, euler.z],
    scale: [
      transform.scale[0] * delta.scale[0],
      transform.scale[1] * delta.scale[1],
      transform.scale[2] * delta.scale[2],
    ],
  };
}

function deltaBetween(
  from: DirectorTransform,
  to: DirectorTransform,
): {
  position: [number, number, number];
  rotation: Quaternion;
  scale: [number, number, number];
} {
  return {
    position: [
      to.position[0] - from.position[0],
      to.position[1] - from.position[1],
      to.position[2] - from.position[2],
    ],
    rotation: quatOf(to.rotation).multiply(quatOf(from.rotation).invert()),
    scale: [
      to.scale[0] / (from.scale[0] || 1),
      to.scale[1] / (from.scale[1] || 1),
      to.scale[2] / (from.scale[2] || 1),
    ],
  };
}

function stamped(scene: DirectorScene): DirectorScene {
  return { ...scene, updatedAt: new Date().toISOString() };
}

/**
 * Writes an object's new transform under the room's AutoKey rule.
 *
 * With AutoKey on the value becomes a keyframe at the snapped playhead and
 * the base is left alone. With it off, an object with no keyframes simply
 * moves, and an object with keyframes moves all of them together.
 */
export function applyObjectTransform(
  scene: DirectorScene,
  id: string,
  to: DirectorTransform,
  autoKey: boolean,
  time: number,
  fps: number,
): DirectorScene {
  return stamped({
    ...scene,
    objects: scene.objects.map((object) => {
      if (object.id !== id) return object;
      if (autoKey) {
        return {
          ...object,
          keyframes: upsertTransformKeyframe(
            object.keyframes,
            snapTime(time, fps),
            to,
          ),
        };
      }
      if (object.keyframes.length === 0) {
        return { ...object, transform: cloneTransform(to) };
      }
      const delta = deltaBetween(object.transform, to);
      return {
        ...object,
        transform: withDelta(object.transform, delta),
        keyframes: object.keyframes.map((frame) => ({
          ...frame,
          transform: withDelta(frame.transform, delta),
        })),
      };
    }),
  });
}

/** The same rule for a camera; its target is moved by the caller. */
export function applyCameraTransform(
  scene: DirectorScene,
  id: string,
  to: DirectorTransform,
  autoKey: boolean,
  time: number,
  fps: number,
): DirectorScene {
  return stamped({
    ...scene,
    cameras: scene.cameras.map((camera) => {
      if (camera.id !== id) return camera;
      if (autoKey) {
        return {
          ...camera,
          keyframes: upsertTransformKeyframe(
            camera.keyframes,
            snapTime(time, fps),
            to,
          ),
        };
      }
      if (camera.keyframes.length === 0) {
        return { ...camera, transform: cloneTransform(to) };
      }
      const delta = deltaBetween(camera.transform, to);
      return {
        ...camera,
        transform: withDelta(camera.transform, delta),
        keyframes: camera.keyframes.map((frame) => ({
          ...frame,
          transform: withDelta(frame.transform, delta),
        })),
      };
    }),
  });
}

/** A rotated joint: static override first, a keyframe too when recording. */
export function applyBoneRotation(
  scene: DirectorScene,
  id: string,
  bone: DirectorBone,
  rotation: DirectorQuat,
  autoKey: boolean,
  time: number,
  fps: number,
): DirectorScene {
  return stamped({
    ...scene,
    objects: scene.objects.map((object) => {
      if (object.id !== id) return object;
      const override = { ...(object.boneOverrides ?? {}), [bone]: rotation };
      if (!autoKey) return { ...object, boneOverrides: override };
      const tracks = (object.boneTracks ?? []).map((track) =>
        track.bone === bone
          ? {
              ...track,
              keyframes: upsertBoneFrame(
                track.keyframes,
                snapTime(time, fps),
                rotation,
              ),
            }
          : track,
      );
      if (!tracks.some((track) => track.bone === bone)) {
        tracks.push({
          bone,
          keyframes: upsertBoneFrame([], snapTime(time, fps), rotation),
        });
      }
      return { ...object, boneOverrides: override, boneTracks: tracks };
    }),
  });
}

function upsertBoneFrame(
  frames: DirectorBoneKeyframe[],
  time: number,
  rotation: DirectorQuat,
): DirectorBoneKeyframe[] {
  const ordered = [...frames].sort((a, b) => a.time - b.time);
  const index = ordered.findIndex(
    (frame) => Math.abs(frame.time - time) < KEY_TOLERANCE,
  );
  if (index >= 0) {
    ordered[index] = {
      ...ordered[index],
      time,
      rotation: [...rotation] as DirectorQuat,
    };
    return ordered;
  }
  return [
    ...ordered,
    { id: newId(), time, rotation: [...rotation] as DirectorQuat },
  ].sort((a, b) => a.time - b.time);
}

/**
 * Records what is drawn at the playhead, at the frame it belongs to.
 *
 * The value comes from the current playhead and the time written is snapped,
 * so recording while playing does not smear a value into the next frame.
 */
export function recordKeyframe(
  scene: DirectorScene,
  selection: {
    kind: "object" | "camera" | "light";
    id: string;
    bone?: DirectorBone;
  } | null,
  playhead: number,
  fps: number,
): DirectorScene {
  const time = snapTime(playhead, fps);
  if (!selection) return scene;
  if (selection.kind === "object") {
    const object = scene.objects.find((entry) => entry.id === selection.id);
    if (!object) return scene;
    if (selection.bone) {
      return applyBoneRotation(
        scene,
        object.id,
        selection.bone,
        boneRotationOrIdentity(object, selection.bone, playhead),
        true,
        time,
        fps,
      );
    }
    const transform =
      sampleTransform(object.keyframes, playhead) ?? object.transform;
    return stamped({
      ...scene,
      objects: scene.objects.map((entry) =>
        entry.id === object.id
          ? {
              ...entry,
              keyframes: upsertTransformKeyframe(
                entry.keyframes,
                time,
                transform,
              ),
            }
          : entry,
      ),
    });
  }
  if (selection.kind === "camera") {
    const camera = scene.cameras.find((entry) => entry.id === selection.id);
    if (!camera) return scene;
    const transform =
      sampleTransform(camera.keyframes, playhead) ?? camera.transform;
    return stamped({
      ...scene,
      cameras: scene.cameras.map((entry) =>
        entry.id === camera.id
          ? {
              ...entry,
              keyframes: upsertTransformKeyframe(
                entry.keyframes,
                time,
                transform,
              ),
            }
          : entry,
      ),
    });
  }
  return scene;
}

/** The transform a camera move ends on, leaving the target in place. */
export function cameraMoveEnd(
  camera: DirectorCamera,
  move: DirectorCameraMove,
): DirectorTransform | null {
  const first = camera.transform;
  const [x, y, z] = first.position;
  const [tx, ty, tz] = camera.target;
  const direction = {
    x: tx - x,
    y: ty - y,
    z: tz - z,
  };
  const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
  const nx = direction.x / length;
  const ny = direction.y / length;
  const nz = direction.z / length;
  const next = cloneTransform(first);
  switch (move) {
    case "static":
      return null;
    case "push_in":
      next.position = [x + nx * 1.8, y + ny * 1.8, z + nz * 1.8];
      break;
    case "pull_out":
      next.position = [x - nx * 2.2, y - ny * 2.2, z - nz * 2.2];
      break;
    case "pan_left":
      next.position = [x - 1.8, y, z];
      break;
    case "pan_right":
      next.position = [x + 1.8, y, z];
      break;
    case "tilt_up":
      next.position = [x, y + 1.4, z];
      break;
    case "tilt_down":
      next.position = [x, y - 1, z];
      break;
    case "orbit_left":
    case "orbit_right": {
      const angle = ((move === "orbit_left" ? 1 : -1) * 22 * Math.PI) / 180;
      const dx = x - tx;
      const dz = z - tz;
      next.position = [
        tx + dx * Math.cos(angle) - dz * Math.sin(angle),
        y,
        tz + dx * Math.sin(angle) + dz * Math.cos(angle),
      ];
      break;
    }
    case "handheld":
      next.position = [x + 0.12, y + 0.05, z + 0.1];
      next.rotation = [
        first.rotation[0],
        first.rotation[1],
        first.rotation[2] + 0.01,
      ];
      break;
  }
  return next;
}

/**
 * The two ends of a camera move, with whatever the reader already put between
 * them kept where it is.
 */
export function cameraMoveKeyframes(
  camera: DirectorCamera,
  move: DirectorCameraMove,
  duration: number,
): DirectorKeyframe[] {
  const start = camera.keyframes.find((frame) => frame.time < KEY_TOLERANCE);
  const firstTransform = start?.transform ?? cloneTransform(camera.transform);
  let frames = upsertTransformKeyframe(
    camera.keyframes,
    start?.time ?? 0,
    firstTransform,
    start?.easing ?? "smooth",
  );
  if (move === "static") return frames;
  const end = cameraMoveEnd(camera, move);
  if (!end) return frames;
  frames = upsertTransformKeyframe(frames, duration, end, "smooth");
  return frames;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface PathPoint {
  x: number;
  z: number;
}

function perpendicularDistance(
  point: PathPoint,
  from: PathPoint,
  to: PathPoint,
): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  if (length === 0) return Math.hypot(point.x - from.x, point.z - from.z);
  return Math.abs(dx * (from.z - point.z) - (from.x - point.x) * dz) / length;
}

/** Ramer–Douglas–Peucker, so a drawn line becomes the corners that matter. */
export function simplifyPath(
  points: readonly PathPoint[],
  tolerance: number,
): PathPoint[] {
  const finite = points.filter(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.z),
  );
  if (finite.length <= 2) return finite.map((point) => ({ ...point }));
  let furthest = 0;
  let index = 0;
  for (let at = 1; at < finite.length - 1; at += 1) {
    const distance = perpendicularDistance(
      finite[at],
      finite[0],
      finite[finite.length - 1],
    );
    if (distance > furthest) {
      furthest = distance;
      index = at;
    }
  }
  if (furthest <= tolerance) {
    return [{ ...finite[0] }, { ...finite[finite.length - 1] }];
  }
  const left = simplifyPath(finite.slice(0, index + 1), tolerance);
  const right = simplifyPath(finite.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}

/**
 * Keyframes along a drawn path, timed by how much of the path was walked.
 *
 * The actor faces the way it is going; a camera faces the other way, because
 * a camera looks down its own −Z. `headingOffset` is that difference.
 */
export function pathKeyframes(
  points: readonly PathPoint[],
  startTime: number,
  duration: number,
  base: DirectorTransform,
  facePath: boolean,
  headingOffset = 0,
): DirectorKeyframe[] {
  const path = simplifyPath(points, 0.025);
  if (path.length === 0) return [];
  const lengths = [0];
  for (let index = 1; index < path.length; index += 1) {
    lengths.push(
      lengths[index - 1] +
        Math.hypot(
          path[index].x - path[index - 1].x,
          path[index].z - path[index - 1].z,
        ),
    );
  }
  const total = lengths[lengths.length - 1] || 1;
  const frames: DirectorKeyframe[] = [];
  path.forEach((point, index) => {
    const next = path[Math.min(index + 1, path.length - 1)];
    const previous = path[Math.max(index - 1, 0)];
    const yaw = Math.atan2(next.x - previous.x, next.z - previous.z);
    frames.push({
      id: newId(),
      time: startTime + (lengths[index] / total) * duration,
      transform: {
        position: [point.x, base.position[1], point.z],
        rotation: facePath
          ? [base.rotation[0], yaw + headingOffset, base.rotation[2]]
          : [...base.rotation],
        scale: [...base.scale],
      },
      ...(index < path.length - 1 ? { easing: "smooth" as const } : {}),
    });
  });
  return frames;
}

/** Adds generated keyframes to a track, replacing frames at the same times. */
export function mergeKeyframes(
  frames: DirectorKeyframe[],
  generated: DirectorKeyframe[],
): DirectorKeyframe[] {
  let merged = sorted(frames);
  for (const frame of generated) {
    merged = upsertTransformKeyframe(
      merged,
      frame.time,
      frame.transform,
      frame.easing,
    );
  }
  return merged;
}
