import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useThree } from "@react-three/fiber";
import {
  Grid,
  Line as DreiLine,
  OrbitControls,
  TransformControls,
} from "@react-three/drei";
import {
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Vector3,
  type Group,
  type Material,
  type Object3D,
} from "three";
import {
  DIRECTOR_ENVIRONMENT_INTENSITY,
  activeShotOf,
  shotCamera,
  type DirectorBone,
  type DirectorQuat,
  type DirectorRenderMode,
  type DirectorScene,
  type DirectorTransform,
} from "../../../shared/domain";
import type {
  DirectorSelection,
  DirectorTransformMode,
  DirectorViewportApi,
} from "../types";
import { EnvironmentView } from "./EnvironmentView";
import {
  ModelView,
  PlateView,
  SolidView,
  type ModelAnimation,
} from "./ModelView";
import { sampleTransform, type PathPoint } from "./animation";
import { PerformerView } from "./PerformerView";
import { CameraRigView, LightRigView, SelectionOutline } from "./RigViews";
import { ORTHO_DIRECTIONS, isOrthoView, type DirectorView } from "./viewModes";
import {
  cameraUsable,
  orthographicDistance,
  orthographicHalfRanges,
  stageBounds,
  verticalFov,
} from "./framing";

export interface StageWorldProps {
  scene: DirectorScene;
  view: DirectorView;
  renderMode: DirectorRenderMode;
  transformMode: DirectorTransformMode;
  selection: DirectorSelection | null;
  onSelect: (selection: DirectorSelection | null) => void;
  onModelError: (objectId: string, message: string) => void;
  onEnvironmentError: (message: string) => void;
  onCameraFallback: (reason: string) => void;
  onModelLoaded: (
    objectId: string,
    animations: ModelAnimation[],
    boneNames: string[],
  ) => void;
  onGroundPoint: (x: number, z: number) => void;
  onTransformPreview: (
    selection: DirectorSelection,
    transform: DirectorTransform,
  ) => void;
  onBonePreview: (selection: DirectorSelection, rotation: DirectorQuat) => void;
  onGestureStart: () => void;
  onGestureEnd: () => void;
  playhead: number;
  pathMode: "object" | "camera" | null;
  showTracks: boolean;
  onPathComplete: (points: PathPoint[]) => void;
  onPathCancel: () => void;
  apiRef?: { current: DirectorViewportApi | null };
  reloadToken: number;
}

const STAGE_FLOOR = "#39414c";

/** Places a shot camera at its data, with the target and roll it holds. */
export function placeShotCamera(
  camera: PerspectiveCamera,
  data: ReturnType<typeof shotCamera>,
  aspect: number,
): boolean {
  if (!data || !cameraUsable(data)) return false;
  const position = new Vector3(...data.transform.position);
  const target = new Vector3(...data.target);
  let direction = target.clone().sub(position);
  if (direction.lengthSq() < 1e-12) {
    direction = new Vector3(0, 0, -1);
  }
  direction.normalize();
  const worldUp = new Vector3(0, 1, 0);
  if (Math.abs(worldUp.dot(direction)) > 0.999) worldUp.set(0, 0, 1);
  if (Math.abs(worldUp.dot(direction)) > 0.999) worldUp.set(1, 0, 0);
  const roll = data.transform.rotation[2] || 0;
  const up = worldUp.applyAxisAngle(direction, roll);
  camera.position.copy(position);
  camera.up.copy(up);
  camera.lookAt(target);
  camera.fov = Math.max(
    1,
    Math.min(179, (verticalFov(data.focalLength, aspect) * 180) / Math.PI),
  );
  camera.aspect = aspect;
  camera.near = data.near;
  camera.far = data.far;
  camera.updateProjectionMatrix();
  return true;
}

function placeOrthoCamera(
  camera: OrthographicCamera,
  scene: DirectorScene,
  view: Exclude<DirectorView, "free" | "camera">,
  aspect: number,
): void {
  const bounds = stageBounds(scene);
  const direction = new Vector3(...ORTHO_DIRECTIONS[view]);
  const centre = new Vector3(...bounds.center);
  const distance = orthographicDistance(bounds);
  const spans =
    view === "top"
      ? [bounds.span[0], bounds.span[2]]
      : view === "front" || view === "back"
        ? [bounds.span[0], bounds.span[1]]
        : [bounds.span[2], bounds.span[1]];
  const half = orthographicHalfRanges(spans[0], spans[1], aspect);
  camera.position.copy(centre).addScaledVector(direction, distance);
  camera.up.set(0, view === "top" ? 0 : 1, view === "top" ? -1 : 0);
  camera.lookAt(centre);
  camera.left = -half.halfWidth;
  camera.right = half.halfWidth;
  camera.top = half.halfHeight;
  camera.bottom = -half.halfHeight;
  camera.near = 0.1;
  camera.far =
    distance + Math.max(bounds.span[0], bounds.span[1], bounds.span[2]) * 4;
  camera.updateProjectionMatrix();
}

/** Keeps the scene's background and lights applied as it changes. */
function StageLighting({ scene }: { scene: DirectorScene }) {
  return (
    <>
      {scene.lights.map((light) => {
        const position = light.transform.position;
        if (light.type === "ambient") {
          return (
            <ambientLight
              color={light.color}
              intensity={light.intensity}
              key={light.id}
            />
          );
        }
        if (light.type === "point") {
          return (
            <pointLight
              castShadow={light.castShadow}
              color={light.color}
              intensity={light.intensity}
              key={light.id}
              position={position}
            />
          );
        }
        if (light.type === "spot") {
          return (
            <spotLight
              angle={light.angle ?? Math.PI / 6}
              castShadow={light.castShadow}
              color={light.color}
              intensity={light.intensity}
              key={light.id}
              penumbra={light.penumbra ?? 0.4}
              position={position}
            />
          );
        }
        return (
          <directionalLight
            castShadow={light.castShadow}
            color={light.color}
            intensity={light.intensity}
            key={light.id}
            position={position}
            shadow-mapSize={[1024, 1024]}
          />
        );
      })}
      <ambientLight
        intensity={
          (scene.environmentIntensity ?? DIRECTOR_ENVIRONMENT_INTENSITY) * 0.35
        }
      />
    </>
  );
}

/**
 * Swaps every non-actor mesh for a neutral blockout material.
 *
 * Traversal is used rather than `scene.overrideMaterial` because the stage's
 * helpers and the performers' reference colours have to survive the swap.
 * Shader materials are left alone: a Grid owns uniforms that a traversal
 * replacing its material would leave updating an object that no longer
 * draws.
 */
function BlockoutMaterials({
  mode,
  sceneKey,
  loadedKey,
}: {
  mode: DirectorRenderMode;
  sceneKey: string;
  loadedKey: number;
}) {
  const { scene, invalidate } = useThree();
  useEffect(() => {
    if (mode !== "blockout") {
      invalidate();
      return;
    }
    const blockout = new MeshStandardMaterial({
      color: "#aeb5bf",
      metalness: 0.02,
      roughness: 0.85,
    });
    const changed: { mesh: Mesh; original: Material | Material[] }[] = [];
    const underFlag = (object: Object3D, flag: string) => {
      let current: Object3D | null = object;
      while (current) {
        if (current.userData?.[flag]) return true;
        current = current.parent;
      }
      return false;
    };
    scene.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      if (
        underFlag(mesh, "directorHelper") ||
        underFlag(mesh, "directorActor")
      ) {
        return;
      }
      const material = mesh.material as Material & { uniforms?: unknown };
      if (!material || material.uniforms) return;
      changed.push({ mesh, original: mesh.material });
      mesh.material = blockout;
    });
    invalidate();
    return () => {
      for (const entry of changed) entry.mesh.material = entry.original;
      blockout.dispose();
      invalidate();
    };
  }, [mode, scene, sceneKey, loadedKey, invalidate]);
  return null;
}

/** Draws a polyline on the stage's floor. */
function PathLine({ points, color }: { points: PathPoint[]; color: string }) {
  if (points.length < 2) return null;
  return (
    <DreiLine
      color={color}
      lineWidth={2}
      points={points.map(
        (point) => [point.x, 0.025, point.z] as [number, number, number],
      )}
      transparent
      opacity={0.85}
    />
  );
}

/** The paths of every animated object and the point each is at now. */
function KeyframePaths({
  scene,
  playhead,
}: {
  scene: DirectorScene;
  playhead: number;
}) {
  return (
    <group userData={{ directorHelper: true }}>
      {scene.objects
        .filter((object) => object.keyframes.length > 0)
        .map((object) => {
          const points = [...object.keyframes]
            .sort((a, b) => a.time - b.time)
            .map((frame) => ({
              x: frame.transform.position[0],
              z: frame.transform.position[2],
            }));
          const now =
            sampleTransform(object.keyframes, playhead) ?? object.transform;
          return (
            <group key={object.id}>
              <PathLine color="#98c379" points={points} />
              <mesh position={[now.position[0], 0.04, now.position[2]]}>
                <sphereGeometry args={[0.06, 10, 8]} />
                <meshBasicMaterial color="#98c379" />
              </mesh>
            </group>
          );
        })}
      {scene.cameras
        .filter((camera) => camera.keyframes.length > 0)
        .map((camera) => {
          const points = [...camera.keyframes]
            .sort((a, b) => a.time - b.time)
            .map((frame) => ({
              x: frame.transform.position[0],
              z: frame.transform.position[2],
            }));
          const now =
            sampleTransform(camera.keyframes, playhead) ?? camera.transform;
          return (
            <group key={camera.id}>
              <PathLine color="#61afef" points={points} />
              <mesh position={[now.position[0], 0.04, now.position[2]]}>
                <sphereGeometry args={[0.06, 10, 8]} />
                <meshBasicMaterial color="#61afef" />
              </mesh>
            </group>
          );
        })}
    </group>
  );
}

/** Draws the scene's objects and the rigs that explain where its makers are. */
export function StageWorld({
  scene,
  view,
  renderMode,
  transformMode,
  selection,
  onSelect,
  onModelError,
  onEnvironmentError,
  onCameraFallback,
  onModelLoaded,
  onGroundPoint,
  onTransformPreview,
  onBonePreview,
  onGestureStart,
  onGestureEnd,
  playhead,
  pathMode,
  showTracks,
  onPathComplete,
  onPathCancel,
  apiRef,
  reloadToken,
}: StageWorldProps) {
  const { camera: activeCamera, size, set, invalidate } = useThree();
  const freeCamera = useRef<PerspectiveCamera | null>(null);
  if (freeCamera.current === null) {
    freeCamera.current = activeCamera as PerspectiveCamera;
  }
  const shot = useMemo(() => new PerspectiveCamera(), []);
  const ortho = useMemo(() => new OrthographicCamera(), []);
  const [loadedKey, setLoadedKey] = useState(0);
  const [selectedNode, setSelectedNode] = useState<Object3D | null>(null);
  const [dragging, setDragging] = useState(false);
  const objectRefs = useRef(new Map<string, Group>());
  const boneRefs = useRef(new Map<string, Group>());
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const refCallbacks = useRef(new Map<string, (node: Group | null) => void>());
  const boneCallbacks = useRef(
    new Map<string, (bone: DirectorBone, node: Group | null) => void>(),
  );
  const groundDown = useRef<{ x: number; y: number } | null>(null);
  const pathPoints = useRef<PathPoint[]>([]);
  const [drawingPath, setDrawingPath] = useState(false);
  const [pathPreview, setPathPreview] = useState<PathPoint[]>([]);
  const pathModeRef = useRef(pathMode);
  pathModeRef.current = pathMode;
  const controls = useRef<{ target: Vector3; update: () => void } | null>(null);
  const aspect =
    size.width > 0 && size.height > 0 ? size.width / size.height : 16 / 9;

  const refFor = (id: string) => {
    const held = refCallbacks.current.get(id);
    if (held) return held;
    const callback = (node: Group | null) => {
      if (node) objectRefs.current.set(id, node);
      else objectRefs.current.delete(id);
      if (selectionRef.current?.id === id) setSelectedNode(node);
    };
    refCallbacks.current.set(id, callback);
    return callback;
  };

  const boneRefFor = (objectId: string) => {
    const held = boneCallbacks.current.get(objectId);
    if (held) return held;
    const callback = (bone: DirectorBone, node: Group | null) => {
      const key = `${objectId}:${bone}`;
      if (node) boneRefs.current.set(key, node);
      else boneRefs.current.delete(key);
      if (
        selectionRef.current?.id === objectId &&
        selectionRef.current.bone === bone
      ) {
        setSelectedNode(node);
      }
    };
    boneCallbacks.current.set(objectId, callback);
    return callback;
  };

  useEffect(() => {
    if (!selection) {
      setSelectedNode(null);
      return;
    }
    const ref = selection.bone
      ? boneRefs.current.get(`${selection.id}:${selection.bone}`)
      : objectRefs.current.get(selection.id);
    setSelectedNode(ref ?? null);
  }, [selection, scene.objects, scene.cameras, scene.lights]);

  useEffect(() => {
    if (pathMode || !drawingPath) return;
    setDrawingPath(false);
    pathPoints.current = [];
    setPathPreview([]);
    setDragging(false);
  }, [pathMode, drawingPath]);

  useEffect(() => {
    if (!apiRef) return;
    const focusTarget = (): Vector3 | null => {
      if (!selection) return null;
      if (selection.kind === "object") {
        const object = scene.objects.find((entry) => entry.id === selection.id);
        if (!object) return null;
        const [x, y, z] = object.transform.position;
        const height =
          object.kind === "performer"
            ? (object.actorBuild?.stature ??
                object.animalBuild?.shoulderHeight ??
                1.7) * object.transform.scale[1]
            : object.kind === "model"
              ? 0.95 * object.transform.scale[1]
              : 0.5 * object.transform.scale[1];
        return new Vector3(x, y + height, z);
      }
      if (selection.kind === "camera") {
        const camera = scene.cameras.find((entry) => entry.id === selection.id);
        return camera ? new Vector3(...camera.transform.position) : null;
      }
      const light = scene.lights.find((entry) => entry.id === selection.id);
      return light ? new Vector3(...light.transform.position) : null;
    };
    const api: DirectorViewportApi = {
      focusSelection: () => {
        const camera = freeCamera.current;
        const target = focusTarget();
        if (!camera || !target) return;
        const currentTarget = controls.current?.target ?? new Vector3(0, 1, 0);
        const direction = camera.position.clone().sub(currentTarget);
        if (direction.lengthSq() < 1e-6) direction.set(6, 3, 8);
        direction.normalize();
        camera.position.copy(target).addScaledVector(direction, 3.2);
        if (controls.current) {
          controls.current.target.copy(target);
          controls.current.update();
        }
        invalidate();
      },
      fitAll: () => {
        const camera = freeCamera.current;
        if (!camera) return;
        const bounds = stageBounds(scene);
        const centre = new Vector3(...bounds.center);
        const radius = Math.max(1.5, Math.hypot(...bounds.span) / 2);
        const currentTarget = controls.current?.target ?? centre;
        const direction = camera.position.clone().sub(currentTarget);
        if (direction.lengthSq() < 1e-6) direction.set(6, 3, 8);
        direction.normalize();
        camera.position.copy(centre).addScaledVector(direction, radius * 2.4);
        if (controls.current) {
          controls.current.target.copy(centre);
          controls.current.update();
        }
        invalidate();
      },
      resetView: () => {
        const camera = freeCamera.current;
        if (!camera) return;
        camera.position.set(6, 2.6, 7.8);
        if (controls.current) {
          controls.current.target.set(0, 1.05, 0);
          controls.current.update();
        }
        invalidate();
      },
      dolly: (factor: number) => {
        const camera = freeCamera.current;
        if (!camera) return;
        const target = controls.current?.target ?? new Vector3(0, 1.05, 0);
        camera.position.copy(
          target
            .clone()
            .addScaledVector(camera.position.clone().sub(target), factor),
        );
        controls.current?.update();
        invalidate();
      },
    };
    apiRef.current = api;
    return () => {
      if (apiRef.current === api) apiRef.current = null;
    };
  }, [apiRef, scene, selection, invalidate]);

  const reportFallback = useCallback(
    (reason: string) => {
      onCameraFallback(reason);
      if (freeCamera.current) set({ camera: freeCamera.current });
    },
    [onCameraFallback, set],
  );

  const reportModelLoaded = useCallback(
    (objectId: string, animations: ModelAnimation[], boneNames: string[]) => {
      setLoadedKey((held) => held + 1);
      onModelLoaded(objectId, animations, boneNames);
    },
    [onModelLoaded],
  );

  useEffect(() => {
    if (view === "free") {
      if (freeCamera.current) set({ camera: freeCamera.current });
      invalidate();
      return;
    }
    if (view === "camera") {
      const current = activeShotOf(scene);
      const data = current ? shotCamera(scene, current) : undefined;
      const animated = data
        ? {
            ...data,
            transform:
              sampleTransform(data.keyframes, playhead) ?? data.transform,
          }
        : undefined;
      if (!animated || !placeShotCamera(shot, animated, aspect)) {
        reportFallback(
          "The active shot has no usable camera; the free view is in use.",
        );
        return;
      }
      set({ camera: shot });
      invalidate();
      return;
    }
    if (isOrthoView(view)) {
      placeOrthoCamera(ortho, scene, view, aspect);
      set({ camera: ortho });
      invalidate();
    }
  }, [
    view,
    scene,
    shot,
    ortho,
    aspect,
    set,
    invalidate,
    reportFallback,
    playhead,
  ]);

  return (
    <>
      <StageLighting scene={scene} />
      <EnvironmentView
        background={scene.background}
        environment={scene.environment}
        environmentIntensity={scene.environmentIntensity}
        onError={onEnvironmentError}
      />
      <mesh
        onPointerDown={(event) => {
          if (pathMode && selection) {
            pathPoints.current = [{ x: event.point.x, z: event.point.z }];
            setPathPreview([...pathPoints.current]);
            setDrawingPath(true);
            setDragging(true);
            return;
          }
          groundDown.current = {
            x: event.nativeEvent.clientX,
            y: event.nativeEvent.clientY,
          };
        }}
        onPointerMove={(event) => {
          if (!drawingPath) return;
          const last = pathPoints.current[pathPoints.current.length - 1];
          if (
            last &&
            Math.hypot(event.point.x - last.x, event.point.z - last.z) < 0.04
          ) {
            return;
          }
          pathPoints.current = [
            ...pathPoints.current,
            { x: event.point.x, z: event.point.z },
          ];
          setPathPreview([...pathPoints.current]);
        }}
        onPointerUp={(event) => {
          if (drawingPath) {
            const points = pathPoints.current;
            pathPoints.current = [];
            setPathPreview([]);
            setDrawingPath(false);
            setDragging(false);
            if (points.length >= 2) onPathComplete(points);
            else onPathCancel();
            return;
          }
          const start = groundDown.current;
          groundDown.current = null;
          if (!start || selection?.kind !== "object") return;
          const moved = Math.hypot(
            event.nativeEvent.clientX - start.x,
            event.nativeEvent.clientY - start.y,
          );
          // A press that travelled is an orbit; only a tap places something.
          if (moved > 5) return;
          onGroundPoint(event.point.x, event.point.z);
        }}
        receiveShadow
        rotation-x={-Math.PI / 2}
      >
        <planeGeometry args={[120, 120]} />
        <meshStandardMaterial
          color={STAGE_FLOOR}
          metalness={0}
          roughness={0.95}
        />
      </mesh>
      {scene.gridVisible && (
        <Grid
          args={[120, 120]}
          cellColor="#5a6472"
          cellSize={0.25}
          cellThickness={0.5}
          fadeDistance={48}
          fadeStrength={1.5}
          infiniteGrid
          position={[0, 0.001, 0]}
          sectionColor="#788391"
          sectionSize={2}
          sectionThickness={1}
        />
      )}
      {scene.objects.map((object) => {
        if (!object.visible) return null;
        const selected =
          selection?.kind === "object" && selection.id === object.id;
        const transform =
          sampleTransform(object.keyframes, playhead) ?? object.transform;
        return (
          <group
            key={object.id}
            onPointerDown={(event) => {
              event.stopPropagation();
              onSelect({ kind: "object", id: object.id });
            }}
            position={transform.position}
            ref={refFor(object.id)}
            rotation={transform.rotation}
            scale={transform.scale}
          >
            {object.kind === "solid" ? (
              <SolidView object={object} />
            ) : object.kind === "plate" ? (
              <PlateView object={object} onError={onModelError} />
            ) : object.kind === "model" || object.assetId ? (
              <ModelView
                object={object}
                onError={onModelError}
                onLoaded={reportModelLoaded}
                reloadToken={reloadToken}
                time={playhead}
              />
            ) : (
              <PerformerView
                object={object}
                onSelect={() => onSelect({ kind: "object", id: object.id })}
                onSelectBone={(bone) =>
                  onSelect({ kind: "object", id: object.id, bone })
                }
                registerBone={boneRefFor(object.id)}
                selected={selected}
                selectedBone={
                  selection?.kind === "object" && selection.id === object.id
                    ? selection.bone
                    : undefined
                }
                time={playhead}
              />
            )}
            {selected && <SelectionOutline object={object} />}
          </group>
        );
      })}
      {view === "free" &&
        scene.cameras.map((camera) => {
          const selected =
            selection?.kind === "camera" && selection.id === camera.id;
          const animated = {
            ...camera,
            transform:
              sampleTransform(camera.keyframes, playhead) ?? camera.transform,
          };
          return (
            <group key={camera.id}>
              <CameraRigView
                camera={animated}
                groupRef={refFor(camera.id)}
                onSelect={() => onSelect({ kind: "camera", id: camera.id })}
                selected={selected}
              />
            </group>
          );
        })}
      {view === "free" &&
        scene.lights.map((light) => {
          const selected =
            selection?.kind === "light" && selection.id === light.id;
          return (
            <LightRigView
              key={light.id}
              groupRef={refFor(light.id)}
              light={light}
              onSelect={() => onSelect({ kind: "light", id: light.id })}
              selected={selected}
            />
          );
        })}
      {showTracks && <KeyframePaths playhead={playhead} scene={scene} />}
      {pathPreview.length > 1 && (
        <PathLine color="#f2ce7a" points={pathPreview} />
      )}
      <BlockoutMaterials
        loadedKey={loadedKey}
        mode={renderMode}
        sceneKey={scene.updatedAt}
      />
      {view === "free" && selection && selectedNode && (
        <TransformControls
          mode={selection.bone ? "rotate" : transformMode}
          object={selectedNode}
          onMouseDown={() => {
            setDragging(true);
            onGestureStart();
          }}
          onMouseUp={() => {
            setDragging(false);
            onGestureEnd();
          }}
          onObjectChange={() => {
            if (!selectedNode) return;
            if (selection.bone) {
              onBonePreview(selection, [
                selectedNode.quaternion.x,
                selectedNode.quaternion.y,
                selectedNode.quaternion.z,
                selectedNode.quaternion.w,
              ]);
              return;
            }
            onTransformPreview(selection, {
              position: [
                selectedNode.position.x,
                selectedNode.position.y,
                selectedNode.position.z,
              ],
              rotation: [
                selectedNode.rotation.x,
                selectedNode.rotation.y,
                selectedNode.rotation.z,
              ],
              scale: [
                selectedNode.scale.x,
                selectedNode.scale.y,
                selectedNode.scale.z,
              ],
            });
          }}
          size={0.85}
        />
      )}
      <OrbitControls
        dampingFactor={0.08}
        enabled={view === "free" && !dragging}
        maxDistance={80}
        minDistance={0.35}
        panSpeed={0.85}
        ref={controls as never}
        rotateSpeed={0.7}
        target={[0, 1.05, 0]}
        zoomSpeed={0.85}
      />
    </>
  );
}
