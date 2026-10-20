import { useMemo } from "react";
import { Color } from "three";
import {
  DIRECTOR_HUMANOID_BUILDS,
  DIRECTOR_ANIMAL_BUILDS,
  type DirectorObject,
} from "../../../shared/domain";

interface PerformerViewProps {
  object: DirectorObject;
  selected: boolean;
  onSelect: () => void;
}

function useShades(color: string) {
  return useMemo(() => {
    const base = new Color(color);
    return {
      base,
      dark: base.clone().multiplyScalar(0.78),
      light: base.clone().multiplyScalar(1.12),
    };
  }, [color]);
}

function limb(
  position: [number, number, number],
  size: [number, number, number],
  color: Color,
  key: string,
) {
  return (
    <mesh
      castShadow
      key={key}
      position={position}
      receiveShadow
      userData={{ directorActor: true }}
    >
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} metalness={0.05} roughness={0.75} />
    </mesh>
  );
}

/**
 * A performer built from the archetype's own proportions.
 *
 * This is the blockout body the desk uses without any model file: heights,
 * shoulder width, and head size come from the document's build, so the
 * silhouette a reader places is the silhouette the prompt describes. The
 * articulated rig replaces these boxes in the animation step, keeping the
 * same measurements.
 */
export function PerformerView({
  object,
  selected,
  onSelect,
}: PerformerViewProps) {
  const shades = useShades(object.color);
  const humanoid = object.archetype !== "dog" && object.archetype !== "horse";
  const build = object.actorBuild ?? DIRECTOR_HUMANOID_BUILDS.standard;
  const animal =
    object.animalBuild ??
    (object.archetype === "dog"
      ? DIRECTOR_ANIMAL_BUILDS.dog
      : DIRECTOR_ANIMAL_BUILDS.horse);
  const selectedGlow = selected ? 0.22 : 0;

  if (humanoid) {
    const height = Math.max(0.4, build.stature);
    const shoulder = Math.max(0.1, build.shoulderSpan);
    const head = height * 0.13 * build.headScale;
    const torso = height * build.torsoShare;
    const leg = Math.max(0.1, height - torso - head);
    const arm = torso * 0.95;
    const limbWidth = Math.max(0.05, shoulder * 0.18);
    return (
      <group
        onPointerDown={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        {limb(
          [shoulder * 0.28, leg / 2, 0],
          [limbWidth, leg, limbWidth * 1.1],
          shades.dark,
          "left-leg",
        )}
        {limb(
          [-shoulder * 0.28, leg / 2, 0],
          [limbWidth, leg, limbWidth * 1.1],
          shades.dark,
          "right-leg",
        )}
        {limb(
          [0, leg + torso / 2, 0],
          [shoulder, torso, shoulder * 0.5],
          shades.base,
          "torso",
        )}
        {limb(
          [shoulder / 2 + limbWidth * 0.6, leg + torso * 0.55, 0],
          [limbWidth, arm, limbWidth],
          shades.base,
          "left-arm",
        )}
        {limb(
          [-shoulder / 2 - limbWidth * 0.6, leg + torso * 0.55, 0],
          [limbWidth, arm, limbWidth],
          shades.base,
          "right-arm",
        )}
        <mesh
          castShadow
          position={[0, leg + torso + head / 2, 0]}
          receiveShadow
          userData={{ directorActor: true }}
        >
          <sphereGeometry args={[head / 2, 20, 16]} />
          <meshStandardMaterial
            color={shades.light}
            emissive={selected ? shades.base : "#000000"}
            emissiveIntensity={selectedGlow}
            metalness={0.05}
            roughness={0.75}
          />
        </mesh>
        {build.accessory === "cane" && (
          <mesh
            castShadow
            position={[shoulder / 2 + limbWidth, leg / 2, 0.12]}
            userData={{ directorActor: true }}
          >
            <cylinderGeometry args={[0.012, 0.012, leg, 8]} />
            <meshStandardMaterial color="#8a6f4d" roughness={0.6} />
          </mesh>
        )}
        {build.accessory === "horns" &&
          [-1, 1].map((side) => (
            <mesh
              castShadow
              key={side}
              position={[side * head * 0.22, leg + torso + head * 1.05, 0]}
              rotation-z={side * 0.35}
              userData={{ directorActor: true }}
            >
              <coneGeometry args={[head * 0.08, head * 0.35, 8]} />
              <meshStandardMaterial color="#d8d2c4" roughness={0.6} />
            </mesh>
          ))}
        {build.accessory === "crown" && (
          <mesh
            castShadow
            position={[0, leg + torso + head * 1.02, 0]}
            rotation-x={Math.PI / 2}
            userData={{ directorActor: true }}
          >
            <torusGeometry args={[head * 0.28, head * 0.045, 8, 20]} />
            <meshStandardMaterial
              color="#e8c65a"
              metalness={0.6}
              roughness={0.3}
            />
          </mesh>
        )}
      </group>
    );
  }

  const shoulderHeight = Math.max(0.15, animal.shoulderHeight);
  const bodyLength = Math.max(0.2, animal.bodyLength);
  const bodyWidth = Math.max(0.05, animal.bodyWidth);
  const legLength = shoulderHeight * 0.78;
  const bodyHeight = shoulderHeight * 0.38;
  const headScale = Math.max(0.5, animal.headScale);
  const headRadius = Math.max(0.08, bodyWidth * 0.75) * headScale;
  return (
    <group
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      {limb(
        [bodyWidth * 0.8, legLength / 2, bodyLength * 0.32],
        [bodyWidth * 0.32, legLength, bodyWidth * 0.32],
        shades.dark,
        "front-left",
      )}
      {limb(
        [-bodyWidth * 0.8, legLength / 2, bodyLength * 0.32],
        [bodyWidth * 0.32, legLength, bodyWidth * 0.32],
        shades.dark,
        "front-right",
      )}
      {limb(
        [bodyWidth * 0.8, legLength / 2, -bodyLength * 0.32],
        [bodyWidth * 0.32, legLength, bodyWidth * 0.32],
        shades.dark,
        "rear-left",
      )}
      {limb(
        [-bodyWidth * 0.8, legLength / 2, -bodyLength * 0.32],
        [bodyWidth * 0.32, legLength, bodyWidth * 0.32],
        shades.dark,
        "rear-right",
      )}
      {limb(
        [0, legLength + bodyHeight / 2, 0],
        [bodyWidth, bodyHeight, bodyLength],
        shades.base,
        "body",
      )}
      {limb(
        [0, legLength + bodyHeight * 1.3, bodyLength * 0.46],
        [bodyWidth * 0.55, legLength * 0.42, bodyWidth * 0.55],
        shades.base,
        "neck",
      )}
      <mesh
        castShadow
        position={[
          0,
          legLength + bodyHeight * 1.3 + headRadius,
          bodyLength * 0.6,
        ]}
        receiveShadow
        userData={{ directorActor: true }}
      >
        <sphereGeometry args={[headRadius, 16, 12]} />
        <meshStandardMaterial
          color={shades.light}
          emissive={selected ? shades.base : "#000000"}
          emissiveIntensity={selectedGlow}
          metalness={0.05}
          roughness={0.75}
        />
      </mesh>
      <mesh
        castShadow
        position={[0, legLength + bodyHeight * 0.9, -bodyLength * 0.62]}
        rotation-x={-0.6}
        userData={{ directorActor: true }}
      >
        <cylinderGeometry
          args={[bodyWidth * 0.08, bodyWidth * 0.14, bodyLength * 0.32, 8]}
        />
        <meshStandardMaterial color={shades.base} roughness={0.75} />
      </mesh>
    </group>
  );
}
