import { i18n } from "../../shared/i18n";
import {
  DIRECTOR_ANIMAL_BUILDS,
  DIRECTOR_HUMANOID_BUILDS,
  DIRECTOR_PALETTE,
  activeShotOf,
  createModel,
  createPerformer,
  createPlate,
  createSolid,
  defaultDirectorCamera,
  defaultDirectorShot,
  defaultPoseFor,
  directorTransform,
  freePosition,
  objectFootprint,
  type DirectorActorArchetype,
  type DirectorCamera,
  type DirectorLight,
  type DirectorObject,
  type DirectorScene,
  type DirectorShot,
  type DirectorSolidShape,
  type DirectorVec3,
  type DirectorCameraMove,
} from "../../shared/domain";

/**
 * The scene edits the desk makes, as pure functions from one scene to the
 * next. A command layer writes the result to the document; the room never
 * mutates a scene it was handed.
 */

function stamp(next: DirectorScene): DirectorScene {
  return { ...next, updatedAt: new Date().toISOString() };
}

function availableName(base: string, taken: string[]): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  let count = 2;
  while (names.has(`${base} ${count}`)) count += 1;
  return `${base} ${count}`;
}

/** The colour a new performer is given: the next one in the stage palette. */
export function nextActorColor(scene: DirectorScene, offset = 0): string {
  const count = scene.objects.filter(
    (object) => object.kind === "performer",
  ).length;
  return DIRECTOR_PALETTE[(count + offset) % DIRECTOR_PALETTE.length];
}

function actorName(scene: DirectorScene): string {
  return availableName(
    i18n.t("director:defaults.actorName", {
      n: 1 + scene.objects.filter((o) => o.kind === "performer").length,
    }),
    scene.objects.map((object) => object.name),
  );
}

/** Where a new object goes: near the anchor, clear of everything placed. */
function placement(
  scene: DirectorScene,
  object: Pick<DirectorObject, "kind" | "transform">,
  anchor: [number, number],
): [number, number] {
  const footprint = objectFootprint(object as DirectorObject);
  return freePosition(scene.objects, footprint, { x: anchor[0], z: anchor[1] });
}

export function addPerformer(
  scene: DirectorScene,
  archetype: DirectorActorArchetype,
  anchor: [number, number],
  color?: string,
): { scene: DirectorScene; id: string } {
  const name = actorName(scene);
  const [x, z] = placement(
    scene,
    { kind: "performer" } as DirectorObject,
    anchor,
  );
  const performer = createPerformer(
    archetype,
    name,
    color ?? nextActorColor(scene),
    [x, 0, z],
  );
  return {
    scene: stamp({ ...scene, objects: [...scene.objects, performer] }),
    id: performer.id,
  };
}

/** Eight performers in two rows, the spacing a wide stage has room for. */
export function addEnsemble(
  scene: DirectorScene,
  anchor: [number, number],
): { scene: DirectorScene; ids: string[] } {
  let working = scene;
  const ids: string[] = [];
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const added = addPerformer(
        working,
        column % 2 === 0 ? "standard" : "slim",
        [anchor[0] + (column - 1.5) * 1.2, anchor[1] + row * 1.2],
      );
      working = added.scene;
      ids.push(added.id);
    }
  }
  return { scene: working, ids };
}

export function addSolid(
  scene: DirectorScene,
  shape: DirectorSolidShape,
  size: DirectorVec3,
  name: string,
  anchor: [number, number],
  color = "#8d96a3",
): { scene: DirectorScene; id: string } {
  const [x, z] = freePosition(
    scene.objects,
    { halfX: size[0] / 2, halfZ: size[2] / 2 },
    { x: anchor[0], z: anchor[1] },
  );
  const object = createSolid(shape, name, color, size, [x, size[1] / 2, z]);
  return {
    scene: stamp({ ...scene, objects: [...scene.objects, object] }),
    id: object.id,
  };
}

export function addModelObject(
  scene: DirectorScene,
  assetId: string,
  name: string,
  anchor: [number, number],
): { scene: DirectorScene; id: string } {
  const [x, z] = freePosition(
    scene.objects,
    { halfX: 0.95, halfZ: 0.95 },
    { x: anchor[0], z: anchor[1] },
  );
  const object = createModel(assetId, name, [x, 0, z]);
  return {
    scene: stamp({ ...scene, objects: [...scene.objects, object] }),
    id: object.id,
  };
}

export function addPlateObject(
  scene: DirectorScene,
  assetId: string,
  name: string,
  sourceNodeId?: string,
): { scene: DirectorScene; id: string } {
  const footprint = objectFootprint({
    kind: "plate",
  } as DirectorObject);
  const [x, z] = freePosition(scene.objects, footprint, { x: 0, z: -1.4 });
  const object = createPlate(
    assetId,
    name,
    [x, 0.9, z],
    [0, 0, 0],
    [1.6, 1.8, 1],
    sourceNodeId,
  );
  return {
    scene: stamp({ ...scene, objects: [...scene.objects, object] }),
    id: object.id,
  };
}

export function updateObject(
  scene: DirectorScene,
  id: string,
  patch: Partial<DirectorObject>,
): DirectorScene {
  return stamp({
    ...scene,
    objects: scene.objects.map((object) =>
      object.id === id ? { ...object, ...patch } : object,
    ),
  });
}

export function removeObject(scene: DirectorScene, id: string): DirectorScene {
  return stamp({
    ...scene,
    objects: scene.objects.filter((object) => object.id !== id),
  });
}

/** A copy of an object, stepped aside by eight-tenths of a metre. */
export function duplicateObject(
  scene: DirectorScene,
  id: string,
): { scene: DirectorScene; id: string } | null {
  const source = scene.objects.find((object) => object.id === id);
  if (!source) return null;
  const copy: DirectorObject = {
    ...structuredClone(source),
    id: crypto.randomUUID(),
    name: availableName(
      i18n.t("director:staging.copyOf", { name: source.name }),
      scene.objects.map((object) => object.name),
    ),
    transform: {
      ...source.transform,
      position: [
        source.transform.position[0] + 0.8,
        source.transform.position[1],
        source.transform.position[2] + 0.8,
      ],
    },
    keyframes: source.keyframes.map((keyframe) => ({
      ...keyframe,
      id: crypto.randomUUID(),
    })),
    boneTracks: source.boneTracks?.map((track) => ({
      ...track,
      keyframes: track.keyframes.map((keyframe) => ({
        ...keyframe,
        id: crypto.randomUUID(),
      })),
    })),
  };
  return {
    scene: stamp({ ...scene, objects: [...scene.objects, copy] }),
    id: copy.id,
  };
}

export function changeArchetype(
  scene: DirectorScene,
  id: string,
  archetype: DirectorActorArchetype,
): DirectorScene {
  return stamp({
    ...scene,
    objects: scene.objects.map((object) => {
      if (object.id !== id) return object;
      const quadruped = archetype === "dog" || archetype === "horse";
      const next: DirectorObject = {
        ...object,
        archetype,
        pose: defaultPoseFor(archetype),
        boneOverrides: undefined,
        boneTracks: undefined,
        motionClips: undefined,
        activeMotionClipId: undefined,
        rig: undefined,
      };
      if (quadruped) {
        next.actorBuild = undefined;
        next.animalBuild = {
          ...DIRECTOR_ANIMAL_BUILDS[archetype],
        };
      } else {
        next.animalBuild = undefined;
        next.actorBuild = { ...DIRECTOR_HUMANOID_BUILDS[archetype] };
      }
      return next;
    }),
  });
}

export function addCamera(
  scene: DirectorScene,
  overrides: Partial<DirectorCamera> = {},
): { scene: DirectorScene; id: string } {
  const name = availableName(
    i18n.t("director:defaults.cameraName"),
    scene.cameras.map((camera) => camera.name),
  );
  const camera = defaultDirectorCamera(name, overrides);
  return {
    scene: stamp({ ...scene, cameras: [...scene.cameras, camera] }),
    id: camera.id,
  };
}

export function updateCamera(
  scene: DirectorScene,
  id: string,
  patch: Partial<DirectorCamera>,
): DirectorScene {
  return stamp({
    ...scene,
    cameras: scene.cameras.map((camera) =>
      camera.id === id ? { ...camera, ...patch } : camera,
    ),
  });
}

export function removeCamera(scene: DirectorScene, id: string): DirectorScene {
  if (scene.cameras.length <= 1) return scene;
  const cameras = scene.cameras.filter((camera) => camera.id !== id);
  const fallback = cameras[0].id;
  return stamp({
    ...scene,
    cameras,
    shots: scene.shots.map((shot) =>
      shot.cameraId === id ? { ...shot, cameraId: fallback } : shot,
    ),
  });
}

export function addLight(
  scene: DirectorScene,
  type: DirectorLight["type"],
): { scene: DirectorScene; id: string } {
  const base = i18n.t(`director:lights.${type}`);
  const name = availableName(
    base,
    scene.lights.map((light) => light.name),
  );
  const light: DirectorLight = {
    id: crypto.randomUUID(),
    name,
    type,
    transform: directorTransform(type === "ambient" ? [0, 0, 0] : [3, 5, 3]),
    color: type === "directional" ? "#fff1e0" : "#ffffff",
    intensity: type === "ambient" ? 0.4 : 1.8,
    castShadow: type === "directional" || type === "spot",
    ...(type === "spot" ? { angle: Math.PI / 6, penumbra: 0.4 } : {}),
  };
  return {
    scene: stamp({ ...scene, lights: [...scene.lights, light] }),
    id: light.id,
  };
}

export function updateLight(
  scene: DirectorScene,
  id: string,
  patch: Partial<DirectorLight>,
): DirectorScene {
  return stamp({
    ...scene,
    lights: scene.lights.map((light) =>
      light.id === id ? { ...light, ...patch } : light,
    ),
  });
}

export function removeLight(scene: DirectorScene, id: string): DirectorScene {
  return stamp({
    ...scene,
    lights: scene.lights.filter((light) => light.id !== id),
  });
}

export function updateShot(
  scene: DirectorScene,
  id: string,
  patch: Partial<DirectorShot>,
): DirectorScene {
  return stamp({
    ...scene,
    shots: scene.shots.map((shot) =>
      shot.id === id ? { ...shot, ...patch } : shot,
    ),
  });
}

export function addShot(scene: DirectorScene): {
  scene: DirectorScene;
  id: string;
} {
  const name = availableName(
    i18n.t("director:staging.shotName", { n: scene.shots.length + 1 }),
    scene.shots.map((shot) => shot.name),
  );
  const shot = defaultDirectorShot(name, scene.cameras[0].id, {
    duration: 5,
    fps: 24,
  });
  return {
    scene: stamp({
      ...scene,
      shots: [...scene.shots, shot],
      activeShotId: shot.id,
    }),
    id: shot.id,
  };
}

export function duplicateShot(
  scene: DirectorScene,
  id: string,
): { scene: DirectorScene; id: string } | null {
  const source = scene.shots.find((shot) => shot.id === id);
  if (!source) return null;
  const copy: DirectorShot = {
    ...structuredClone(source),
    id: crypto.randomUUID(),
    name: availableName(
      i18n.t("director:staging.copyOf", { name: source.name }),
      scene.shots.map((shot) => shot.name),
    ),
  };
  return {
    scene: stamp({
      ...scene,
      shots: [...scene.shots, copy],
      activeShotId: copy.id,
    }),
    id: copy.id,
  };
}

export function removeShot(scene: DirectorScene, id: string): DirectorScene {
  if (scene.shots.length <= 1) return scene;
  const index = scene.shots.findIndex((shot) => shot.id === id);
  const shots = scene.shots.filter((shot) => shot.id !== id);
  return stamp({
    ...scene,
    shots,
    activeShotId:
      scene.activeShotId === id
        ? shots[Math.max(0, Math.min(index, shots.length - 1))].id
        : scene.activeShotId,
  });
}

export function setActiveShot(scene: DirectorScene, id: string): DirectorScene {
  if (!scene.shots.some((shot) => shot.id === id)) return scene;
  return stamp({ ...scene, activeShotId: id });
}

export function updateScene(
  scene: DirectorScene,
  patch: Partial<DirectorScene>,
): DirectorScene {
  return stamp({ ...scene, ...patch });
}

/** The cameras the desk offers as starting points. */
export interface CameraPreset {
  id: string;
  position: DirectorVec3;
  target: DirectorVec3;
  focalLength: number;
  roll?: number;
}

export const CAMERA_PRESETS: CameraPreset[] = [
  {
    id: "frontWide",
    position: [0, 1.8, 8.5],
    target: [0, 1, 0],
    focalLength: 28,
  },
  {
    id: "frontMedium",
    position: [0, 1.5, 4.6],
    target: [0, 1.1, 0],
    focalLength: 50,
  },
  {
    id: "frontClose",
    position: [0, 1.62, 2.4],
    target: [0, 1.55, 0],
    focalLength: 75,
  },
  {
    id: "sideFollow",
    position: [4.6, 1.45, 0],
    target: [0, 1.05, 0],
    focalLength: 45,
  },
  {
    id: "backMedium",
    position: [0, 1.55, -5.2],
    target: [0, 1, 0],
    focalLength: 50,
  },
  {
    id: "highBlocking",
    position: [4.2, 5.8, 5],
    target: [0, 0.6, 0],
    focalLength: 35,
  },
  {
    id: "overhead",
    position: [0, 9.5, 0.2],
    target: [0, 0, 0],
    focalLength: 30,
  },
  {
    id: "lowAngle",
    position: [0, 0.35, 4.2],
    target: [0, 2, 0],
    focalLength: 38,
  },
  {
    id: "overShoulderLeft",
    position: [-1.4, 1.72, 2.5],
    target: [0.8, 1.6, 0],
    focalLength: 55,
  },
  {
    id: "overShoulderRight",
    position: [1.4, 1.72, 2.5],
    target: [-0.8, 1.6, 0],
    focalLength: 55,
  },
  {
    id: "diagonal",
    position: [3.1, 1.68, 4.2],
    target: [0, 1.2, 0],
    focalLength: 50,
    roll: (6 * Math.PI) / 180,
  },
];

export function cameraFromPreset(
  scene: DirectorScene,
  preset: CameraPreset,
): { scene: DirectorScene; id: string } {
  return addCamera(scene, {
    transform: directorTransform(preset.position, [0, 0, preset.roll ?? 0]),
    target: preset.target,
    focalLength: preset.focalLength,
  });
}

/** The geometric props a desk offers, in metres. */
export interface DirectorProp {
  id: string;
  shape: DirectorSolidShape;
  size: DirectorVec3;
  color?: string;
}

export const DIRECTOR_PROP_GROUPS: { id: string; props: DirectorProp[] }[] = [
  {
    id: "furniture",
    props: [
      {
        id: "longTable",
        shape: "box",
        size: [1.8, 0.76, 0.9],
        color: "#6b5a4a",
      },
      {
        id: "sideTable",
        shape: "box",
        size: [0.55, 0.55, 0.55],
        color: "#6b5a4a",
      },
      { id: "bookshelf", shape: "box", size: [1.2, 2, 0.35], color: "#5d4a3a" },
      { id: "bench", shape: "box", size: [1.5, 0.45, 0.4], color: "#7a6248" },
      { id: "screen", shape: "box", size: [1.8, 2, 0.08], color: "#50483f" },
    ],
  },
  {
    id: "space",
    props: [
      { id: "lowWall", shape: "box", size: [4, 1.1, 0.2], color: "#6e7681" },
      { id: "doorway", shape: "box", size: [1, 2.2, 0.15], color: "#5b6472" },
      { id: "window", shape: "box", size: [1.4, 1.2, 0.12], color: "#5b6472" },
      { id: "steps", shape: "box", size: [1.2, 0.18, 0.32], color: "#6a707b" },
      { id: "platform", shape: "box", size: [5, 0.12, 5], color: "#3c434d" },
    ],
  },
  {
    id: "environment",
    props: [
      { id: "bush", shape: "sphere", size: [1.8, 2.6, 1.8], color: "#4f7a4f" },
      { id: "rock", shape: "sphere", size: [1.2, 0.9, 1], color: "#6e6a63" },
      { id: "hill", shape: "sphere", size: [9, 3.5, 7], color: "#4d5b45" },
      {
        id: "groundSheet",
        shape: "plane",
        size: [8, 0.04, 8],
        color: "#3c434d",
      },
    ],
  },
  {
    id: "props",
    props: [
      {
        id: "floorLamp",
        shape: "cylinder",
        size: [0.4, 1.75, 0.4],
        color: "#c9b48a",
      },
      { id: "crate", shape: "box", size: [0.55, 0.55, 0.55], color: "#7a6248" },
      { id: "ball", shape: "sphere", size: [0.5, 0.5, 0.5], color: "#c96b5a" },
      { id: "car", shape: "box", size: [4.2, 1.4, 1.9], color: "#546a82" },
    ],
  },
];

export function firstCameraShot(
  scene: DirectorScene,
): DirectorShot | undefined {
  return activeShotOf(scene);
}

/** The words an actor's archetype is offered under. */
export const ACTOR_ARCHETYPE_KEYS: Record<DirectorActorArchetype, string> = {
  standard: "director:actors.standard",
  youth: "director:actors.youth",
  senior: "director:actors.senior",
  broad: "director:actors.broad",
  slim: "director:actors.slim",
  stylized: "director:actors.stylized",
  dog: "director:actors.dog",
  horse: "director:actors.horse",
};

/** How each camera move is named, in the words the prompt also uses. */
export const CAMERA_MOVE_KEYS: Record<DirectorCameraMove, string> = {
  static: "director:cameraMove.static",
  push_in: "director:cameraMove.push_in",
  pull_out: "director:cameraMove.pull_out",
  pan_left: "director:cameraMove.pan_left",
  pan_right: "director:cameraMove.pan_right",
  tilt_up: "director:cameraMove.tilt_up",
  tilt_down: "director:cameraMove.tilt_down",
  orbit_left: "director:cameraMove.orbit_left",
  orbit_right: "director:cameraMove.orbit_right",
  handheld: "director:cameraMove.handheld",
};
