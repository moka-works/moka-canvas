import { useMemo } from "react";
import {
  BoxGeometry,
  BufferGeometry,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  Vector3,
} from "three";
import {
  DIRECTOR_HUMANOID_BUILDS,
  type DirectorCamera,
  type DirectorLight,
  type DirectorObject,
} from "../../../shared/domain";
import { verticalFov } from "./framing";

interface RigProps {
  selected: boolean;
  onSelect: () => void;
}

function FrustumLines({ camera }: { camera: DirectorCamera }) {
  const geometry = useMemo(() => {
    const worldPosition = new Vector3(...camera.transform.position);
    const worldTarget = new Vector3(...camera.target);
    let direction = worldTarget.clone().sub(worldPosition);
    if (direction.lengthSq() < 1e-12) direction = new Vector3(0, 0, -1);
    direction.normalize();
    const up = new Vector3(0, 1, 0);
    if (Math.abs(direction.dot(up)) > 0.999) up.set(0, 0, 1);
    const right = new Vector3().crossVectors(direction, up).normalize();
    const vertical = new Vector3().crossVectors(right, direction).normalize();
    const length = 1.3;
    const aspect = 16 / 9;
    const halfHeight =
      Math.tan(verticalFov(camera.focalLength, aspect) / 2) * length;
    const halfWidth = halfHeight * aspect;
    // The group carrying this line stands at the camera, so the cone is
    // written around its own origin rather than in world coordinates.
    const origin = new Vector3(0, 0, 0);
    const centre = direction.clone().multiplyScalar(length);
    const corners = [
      centre
        .clone()
        .addScaledVector(right, halfWidth)
        .addScaledVector(vertical, halfHeight),
      centre
        .clone()
        .addScaledVector(right, -halfWidth)
        .addScaledVector(vertical, halfHeight),
      centre
        .clone()
        .addScaledVector(right, -halfWidth)
        .addScaledVector(vertical, -halfHeight),
      centre
        .clone()
        .addScaledVector(right, halfWidth)
        .addScaledVector(vertical, -halfHeight),
    ];
    const points: number[] = [];
    const push = (from: Vector3, to: Vector3) => {
      points.push(from.x, from.y, from.z, to.x, to.y, to.z);
    };
    for (const corner of corners) push(origin, corner);
    for (let index = 0; index < 4; index += 1) {
      push(corners[index], corners[(index + 1) % 4]);
    }
    const built = new BufferGeometry();
    built.setAttribute("position", new Float32BufferAttribute(points, 3));
    return built;
  }, [camera.focalLength, camera.target, camera.transform.position]);

  return (
    <lineSegments geometry={geometry} userData={{ directorHelper: true }}>
      <lineBasicMaterial color="#61afef" transparent opacity={0.75} />
    </lineSegments>
  );
}

/** A camera's body and the cone it sees, in the free view only. */
export function CameraRigView({
  camera,
  selected,
  onSelect,
}: RigProps & { camera: DirectorCamera }) {
  const [x, y, z] = camera.transform.position;
  return (
    <group position={[x, y, z]} userData={{ directorHelper: true }}>
      <mesh
        onPointerDown={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        position={[0, 0, 0]}
      >
        <boxGeometry args={[0.26, 0.18, 0.34]} />
        <meshStandardMaterial
          color={selected ? "#f2ce7a" : "#61afef"}
          metalness={0.3}
          roughness={0.5}
        />
      </mesh>
      <mesh position={[0, 0, 0.24]} rotation-x={Math.PI / 2}>
        <cylinderGeometry args={[0.07, 0.09, 0.16, 16]} />
        <meshStandardMaterial color="#d6dbe4" metalness={0.6} roughness={0.3} />
      </mesh>
      <FrustumLines camera={camera} />
    </group>
  );
}

/** A light's place on the stage, drawn as a small mark and its aim. */
export function LightRigView({
  light,
  selected,
  onSelect,
}: RigProps & { light: DirectorLight }) {
  const [x, y, z] = light.transform.position;
  const hasAim = light.type === "directional" || light.type === "spot";
  return (
    <group position={[x, y, z]} userData={{ directorHelper: true }}>
      <mesh
        onPointerDown={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        <octahedronGeometry args={[0.16, 0]} />
        <meshStandardMaterial
          color={selected ? "#f2ce7a" : light.color}
          emissive={light.color}
          emissiveIntensity={0.45}
        />
      </mesh>
      {hasAim && (
        <line>
          <bufferGeometry>
            <float32BufferAttribute
              args={[new Float32Array([0, 0, 0, -x, -y + 1, -z]), 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial color={light.color} transparent opacity={0.35} />
        </line>
      )}
    </group>
  );
}

function objectVolume(object: DirectorObject): {
  centre: [number, number, number];
  size: [number, number, number];
} {
  // Local to the object's group: the group already carries the position,
  // rotation, and scale the reader gave it.
  if (object.kind === "performer") {
    const height =
      object.actorBuild?.stature ??
      object.animalBuild?.shoulderHeight ??
      DIRECTOR_HUMANOID_BUILDS.standard.stature;
    return {
      centre: [0, height / 2, 0],
      size: [0.7, height, 0.7],
    };
  }
  if (object.kind === "model") {
    return { centre: [0, 0.95, 0], size: [1.9, 1.9, 1.9] };
  }
  if (object.kind === "plate") {
    return { centre: [0, 0, 0], size: [1, 1, 0.04] };
  }
  return { centre: [0, 0, 0], size: [1, 1, 1] };
}

/** A yellow box around the selected object and a ring on the floor. */
export function SelectionOutline({ object }: { object: DirectorObject }) {
  const { centre, size } = objectVolume(object);
  const radius = Math.max(size[0], size[2]) * 0.62;
  const edges = useMemo(
    () => new EdgesGeometry(new BoxGeometry(...size)),
    [size[0], size[1], size[2]],
  );
  return (
    <group userData={{ directorHelper: true }}>
      <lineSegments geometry={edges} position={centre}>
        <lineBasicMaterial color="#f2ce7a" />
      </lineSegments>
      <mesh position={[centre[0], 0.015, centre[2]]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[radius * 0.92, radius, 40]} />
        <meshBasicMaterial
          color="#f2ce7a"
          opacity={0.55}
          side={DoubleSide}
          transparent
        />
      </mesh>
    </group>
  );
}
