import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useThree } from "@react-three/fiber";
import { Grid, OrbitControls } from "@react-three/drei";
import {
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Vector3,
  type Material,
  type Object3D,
} from "three";
import {
  DIRECTOR_ENVIRONMENT_INTENSITY,
  activeShotOf,
  shotCamera,
  type DirectorRenderMode,
  type DirectorScene,
} from "../../../shared/domain";
import { EnvironmentView } from "./EnvironmentView";
import { ModelView, PlateView, SolidView } from "./ModelView";
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

export interface DirectorSelection {
  kind: "object" | "camera" | "light";
  id: string;
}

export interface StageWorldProps {
  scene: DirectorScene;
  view: DirectorView;
  renderMode: DirectorRenderMode;
  selection: DirectorSelection | null;
  onSelect: (selection: DirectorSelection | null) => void;
  onModelError: (objectId: string, message: string) => void;
  onEnvironmentError: (message: string) => void;
  onCameraFallback: (reason: string) => void;
  onModelLoaded: (objectId: string, animationNames: string[]) => void;
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

/** Draws the scene's objects and the rigs that explain where its makers are. */
export function StageWorld({
  scene,
  view,
  renderMode,
  selection,
  onSelect,
  onModelError,
  onEnvironmentError,
  onCameraFallback,
  onModelLoaded,
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
  const aspect =
    size.width > 0 && size.height > 0 ? size.width / size.height : 16 / 9;

  const reportFallback = useCallback(
    (reason: string) => {
      onCameraFallback(reason);
      if (freeCamera.current) set({ camera: freeCamera.current });
    },
    [onCameraFallback, set],
  );

  const reportModelLoaded = useCallback(
    (objectId: string, animationNames: string[]) => {
      setLoadedKey((held) => held + 1);
      onModelLoaded(objectId, animationNames);
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
      if (!data || !placeShotCamera(shot, data, aspect)) {
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
  }, [view, scene, shot, ortho, aspect, set, invalidate, reportFallback]);

  return (
    <>
      <StageLighting scene={scene} />
      <EnvironmentView
        background={scene.background}
        environment={scene.environment}
        environmentIntensity={scene.environmentIntensity}
        onError={onEnvironmentError}
      />
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
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
        return (
          <group
            key={object.id}
            onPointerDown={(event) => {
              event.stopPropagation();
              onSelect({ kind: "object", id: object.id });
            }}
            position={object.transform.position}
            rotation={object.transform.rotation}
            scale={object.transform.scale}
          >
            {object.kind === "solid" ? (
              <SolidView object={object} />
            ) : object.kind === "plate" ? (
              <PlateView object={object} onError={onModelError} />
            ) : object.kind === "model" ? (
              <ModelView
                object={object}
                onError={onModelError}
                onLoaded={reportModelLoaded}
                reloadToken={reloadToken}
              />
            ) : (
              <PerformerView
                object={object}
                onSelect={() => onSelect({ kind: "object", id: object.id })}
                selected={selected}
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
          return (
            <group key={camera.id}>
              <CameraRigView
                camera={camera}
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
              light={light}
              onSelect={() => onSelect({ kind: "light", id: light.id })}
              selected={selected}
            />
          );
        })}
      <BlockoutMaterials
        loadedKey={loadedKey}
        mode={renderMode}
        sceneKey={scene.updatedAt}
      />
      <OrbitControls
        dampingFactor={0.08}
        enabled={view === "free"}
        maxDistance={80}
        minDistance={0.35}
        panSpeed={0.85}
        rotateSpeed={0.7}
        target={[0, 1.05, 0]}
        zoomSpeed={0.85}
      />
    </>
  );
}
