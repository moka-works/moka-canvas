import { useMemo, type ReactNode } from "react";
import { Color } from "three";
import {
  DIRECTOR_ANIMAL_BUILDS,
  DIRECTOR_HUMANOID_BUILDS,
  type DirectorBone,
  type DirectorObject,
} from "../../../shared/domain";
import { boneRotationOrIdentity } from "./poses";

export interface PerformerViewProps {
  object: DirectorObject;
  selected: boolean;
  time: number;
  selectedBone?: DirectorBone | null;
  onSelectBone?: (bone: DirectorBone) => void;
  registerBone?: (
    bone: DirectorBone,
    group: import("three").Group | null,
  ) => void;
  onSelect: () => void;
}

function useShades(color: string) {
  return useMemo(() => {
    const base = new Color(color);
    return {
      base,
      dark: base.clone().multiplyScalar(0.76),
      light: base.clone().multiplyScalar(1.12),
    };
  }, [color]);
}

interface BoneProps {
  name: DirectorBone;
  object: DirectorObject;
  time: number;
  selectedBone?: DirectorBone | null;
  onSelectBone?: (bone: DirectorBone) => void;
  registerBone?: PerformerViewProps["registerBone"];
  position?: [number, number, number];
  children: ReactNode;
}

/**
 * One joint of the procedural skeleton.
 *
 * The group is the bone: its rotation is the bone's local pose, and every
 * mesh and child joint hangs from it so a turn at one joint carries the whole
 * limb. Its control point is drawn only while the performer is selected.
 */
function Bone({
  name,
  object,
  time,
  selectedBone,
  onSelectBone,
  registerBone,
  position = [0, 0, 0],
  children,
}: BoneProps) {
  const rotation = boneRotationOrIdentity(object, name, time);
  return (
    <group
      name={name}
      position={position}
      quaternion={rotation}
      ref={(group) => registerBone?.(name, group)}
    >
      {children}
      {onSelectBone && (
        <mesh
          onPointerDown={(event) => {
            event.stopPropagation();
            onSelectBone(name);
          }}
          position={[0, 0, 0]}
          userData={{ directorHelper: true }}
        >
          <sphereGeometry
            args={[selectedBone === name ? 0.055 : 0.04, 10, 8]}
          />
          <meshBasicMaterial
            color={selectedBone === name ? "#f2ce7a" : "#61afef"}
            opacity={selectedBone === name ? 1 : 0.55}
            transparent
          />
        </mesh>
      )}
    </group>
  );
}

function segment(
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
 * A performer with an articulated skeleton.
 *
 * The boxes are the blockout body; the groups between them are the bones the
 * document names, so a pose is the rotations of those groups and a keyframe
 * is a quaternion on one of them.
 */
export function PerformerView({
  object,
  selected,
  time,
  selectedBone,
  onSelectBone,
  registerBone,
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
  const emissive = selected ? 0.18 : 0;
  const boneProps = {
    object,
    time,
    selectedBone: selected ? selectedBone : null,
    onSelectBone: selected ? onSelectBone : undefined,
    registerBone,
  };

  if (humanoid) {
    const height = Math.max(0.4, build.stature);
    const shoulder = Math.max(0.1, build.shoulderSpan);
    const head = height * 0.13 * build.headScale;
    const hipY = height * 0.47;
    const torso = height * build.torsoShare;
    const spineLength = torso * 0.52;
    const chestLength = torso * 0.48;
    const neckLength = height * 0.045;
    const armLength = height * 0.44;
    const upperArm = armLength * 0.52;
    const lowerArm = armLength * 0.4;
    const hipHalf = shoulder * 0.3;
    const upperLeg = hipY * 0.52;
    const lowerLeg = hipY * 0.42;
    const limb = Math.max(0.05, shoulder * 0.17);
    return (
      <group
        onPointerDown={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        <Bone name="root" {...boneProps}>
          <Bone name="hips" {...boneProps} position={[0, hipY, 0]}>
            {segment(
              [0, 0, 0],
              [shoulder * 0.52, height * 0.055, shoulder * 0.3],
              shades.dark,
              "pelvis",
            )}
            <Bone name="spine" {...boneProps}>
              {segment(
                [0, spineLength / 2, 0],
                [shoulder * 0.36, spineLength, shoulder * 0.26],
                shades.base,
                "spine-mesh",
              )}
              <Bone name="chest" {...boneProps} position={[0, spineLength, 0]}>
                {segment(
                  [0, chestLength / 2, 0],
                  [shoulder * 0.46, chestLength, shoulder * 0.3],
                  shades.base,
                  "chest-mesh",
                )}
                <Bone name="neck" {...boneProps} position={[0, chestLength, 0]}>
                  {segment(
                    [0, neckLength / 2, 0],
                    [limb * 0.8, neckLength, limb * 0.8],
                    shades.light,
                    "neck-mesh",
                  )}
                  <Bone
                    name="head"
                    {...boneProps}
                    position={[0, neckLength, 0]}
                  >
                    <mesh
                      castShadow
                      position={[0, head / 2, 0]}
                      receiveShadow
                      userData={{ directorActor: true }}
                    >
                      <sphereGeometry args={[head / 2, 20, 16]} />
                      <meshStandardMaterial
                        color={shades.light}
                        emissive={shades.base}
                        emissiveIntensity={emissive}
                        metalness={0.05}
                        roughness={0.75}
                      />
                    </mesh>
                    {build.accessory === "horns" &&
                      [-1, 1].map((side) => (
                        <mesh
                          castShadow
                          key={side}
                          position={[side * head * 0.2, head * 0.95, 0]}
                          rotation-z={side * 0.35}
                          userData={{ directorActor: true }}
                        >
                          <coneGeometry args={[head * 0.08, head * 0.35, 8]} />
                          <meshStandardMaterial
                            color="#d8d2c4"
                            roughness={0.6}
                          />
                        </mesh>
                      ))}
                    {build.accessory === "crown" && (
                      <mesh
                        castShadow
                        position={[0, head * 0.98, 0]}
                        rotation-x={Math.PI / 2}
                        userData={{ directorActor: true }}
                      >
                        <torusGeometry
                          args={[head * 0.28, head * 0.045, 8, 20]}
                        />
                        <meshStandardMaterial
                          color="#e8c65a"
                          metalness={0.6}
                          roughness={0.3}
                        />
                      </mesh>
                    )}
                  </Bone>
                </Bone>
                <Bone
                  name="leftShoulder"
                  {...boneProps}
                  position={[shoulder * 0.42, chestLength * 0.82, 0]}
                >
                  <Bone name="leftUpperArm" {...boneProps}>
                    {segment(
                      [0, -upperArm / 2, 0],
                      [limb, upperArm, limb],
                      shades.base,
                      "left-upper-arm",
                    )}
                    <Bone
                      name="leftLowerArm"
                      {...boneProps}
                      position={[0, -upperArm, 0]}
                    >
                      {segment(
                        [0, -lowerArm / 2, 0],
                        [limb * 0.9, lowerArm, limb * 0.9],
                        shades.light,
                        "left-lower-arm",
                      )}
                      <Bone
                        name="leftHand"
                        {...boneProps}
                        position={[0, -lowerArm, 0]}
                      >
                        {segment(
                          [0, -limb * 0.4, 0],
                          [limb * 0.85, limb * 0.9, limb * 0.7],
                          shades.light,
                          "left-hand",
                        )}
                      </Bone>
                    </Bone>
                  </Bone>
                </Bone>
                <Bone
                  name="rightShoulder"
                  {...boneProps}
                  position={[-shoulder * 0.42, chestLength * 0.82, 0]}
                >
                  <Bone name="rightUpperArm" {...boneProps}>
                    {segment(
                      [0, -upperArm / 2, 0],
                      [limb, upperArm, limb],
                      shades.base,
                      "right-upper-arm",
                    )}
                    <Bone
                      name="rightLowerArm"
                      {...boneProps}
                      position={[0, -upperArm, 0]}
                    >
                      {segment(
                        [0, -lowerArm / 2, 0],
                        [limb * 0.9, lowerArm, limb * 0.9],
                        shades.light,
                        "right-lower-arm",
                      )}
                      <Bone
                        name="rightHand"
                        {...boneProps}
                        position={[0, -lowerArm, 0]}
                      >
                        {segment(
                          [0, -limb * 0.4, 0],
                          [limb * 0.85, limb * 0.9, limb * 0.7],
                          shades.light,
                          "right-hand",
                        )}
                        {build.accessory === "cane" && (
                          <mesh
                            castShadow
                            position={[0, -height * 0.2, 0.06]}
                            userData={{ directorActor: true }}
                          >
                            <cylinderGeometry
                              args={[0.012, 0.012, height * 0.42, 8]}
                            />
                            <meshStandardMaterial
                              color="#8a6f4d"
                              roughness={0.6}
                            />
                          </mesh>
                        )}
                      </Bone>
                    </Bone>
                  </Bone>
                </Bone>
              </Bone>
            </Bone>
            <Bone name="leftUpperLeg" {...boneProps} position={[hipHalf, 0, 0]}>
              {segment(
                [0, -upperLeg / 2, 0],
                [limb * 1.15, upperLeg, limb * 1.2],
                shades.dark,
                "left-upper-leg",
              )}
              <Bone
                name="leftLowerLeg"
                {...boneProps}
                position={[0, -upperLeg, 0]}
              >
                {segment(
                  [0, -lowerLeg / 2, 0],
                  [limb, lowerLeg, limb],
                  shades.dark,
                  "left-lower-leg",
                )}
                <Bone
                  name="leftFoot"
                  {...boneProps}
                  position={[0, -lowerLeg, 0]}
                >
                  {segment(
                    [0, -height * 0.025, 0.04],
                    [limb * 1.1, height * 0.05, limb * 1.9],
                    shades.dark,
                    "left-foot",
                  )}
                </Bone>
              </Bone>
            </Bone>
            <Bone
              name="rightUpperLeg"
              {...boneProps}
              position={[-hipHalf, 0, 0]}
            >
              {segment(
                [0, -upperLeg / 2, 0],
                [limb * 1.15, upperLeg, limb * 1.2],
                shades.dark,
                "right-upper-leg",
              )}
              <Bone
                name="rightLowerLeg"
                {...boneProps}
                position={[0, -upperLeg, 0]}
              >
                {segment(
                  [0, -lowerLeg / 2, 0],
                  [limb, lowerLeg, limb],
                  shades.dark,
                  "right-lower-leg",
                )}
                <Bone
                  name="rightFoot"
                  {...boneProps}
                  position={[0, -lowerLeg, 0]}
                >
                  {segment(
                    [0, -height * 0.025, 0.04],
                    [limb * 1.1, height * 0.05, limb * 1.9],
                    shades.dark,
                    "right-foot",
                  )}
                </Bone>
              </Bone>
            </Bone>
          </Bone>
        </Bone>
      </group>
    );
  }

  const shoulderHeight = Math.max(0.15, animal.shoulderHeight);
  const bodyLength = Math.max(0.2, animal.bodyLength);
  const bodyWidth = Math.max(0.05, animal.bodyWidth);
  const hipY = shoulderHeight * 0.82;
  const bodyHeight = shoulderHeight * 0.34;
  const headRadius = Math.max(0.07, bodyWidth * 0.55) * animal.headScale;
  const upperLeg = hipY * 0.52;
  const lowerLeg = hipY * 0.4;
  const legWidth = bodyWidth * 0.28;
  const neckLength = bodyLength * 0.16;
  return (
    <group
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      <Bone name="root" {...boneProps}>
        <Bone
          name="hips"
          {...boneProps}
          position={[0, hipY, -bodyLength * 0.3]}
        >
          {segment(
            [0, 0, 0],
            [bodyWidth, bodyHeight, bodyLength * 0.32],
            shades.base,
            "haunch",
          )}
          <Bone
            name="spine"
            {...boneProps}
            position={[0, 0, bodyLength * 0.16]}
          >
            {segment(
              [0, 0, bodyLength * 0.1],
              [bodyWidth * 0.95, bodyHeight * 0.9, bodyLength * 0.24],
              shades.base,
              "spine-mesh",
            )}
            <Bone
              name="chest"
              {...boneProps}
              position={[0, 0, bodyLength * 0.24]}
            >
              {segment(
                [0, 0, bodyLength * 0.06],
                [bodyWidth, bodyHeight, bodyLength * 0.18],
                shades.base,
                "chest-mesh",
              )}
              <Bone
                name="neck"
                {...boneProps}
                position={[0, bodyHeight * 0.35, bodyLength * 0.16]}
              >
                {segment(
                  [0, neckLength * 0.3, neckLength * 0.1],
                  [bodyWidth * 0.5, neckLength, bodyWidth * 0.5],
                  shades.light,
                  "neck-mesh",
                )}
                <Bone
                  name="head"
                  {...boneProps}
                  position={[0, neckLength * 0.6, bodyLength * 0.12]}
                >
                  <mesh
                    castShadow
                    position={[0, 0, headRadius * 0.6]}
                    receiveShadow
                    userData={{ directorActor: true }}
                  >
                    <sphereGeometry args={[headRadius, 16, 12]} />
                    <meshStandardMaterial
                      color={shades.light}
                      emissive={shades.base}
                      emissiveIntensity={emissive}
                      metalness={0.05}
                      roughness={0.75}
                    />
                  </mesh>
                </Bone>
              </Bone>
              {[
                { side: "Left", x: bodyWidth * 0.42 },
                { side: "Right", x: -bodyWidth * 0.42 },
              ].map(({ side, x }) => (
                <Bone
                  key={side}
                  name={`front${side}UpperLeg` as DirectorBone}
                  {...boneProps}
                  position={[x, -bodyHeight * 0.3, bodyLength * 0.1]}
                >
                  {segment(
                    [0, -upperLeg / 2, 0],
                    [legWidth, upperLeg, legWidth],
                    shades.dark,
                    `${side}-front-upper`,
                  )}
                  <Bone
                    name={`front${side}LowerLeg` as DirectorBone}
                    {...boneProps}
                    position={[0, -upperLeg, 0]}
                  >
                    {segment(
                      [0, -lowerLeg / 2, 0],
                      [legWidth * 0.85, lowerLeg, legWidth * 0.85],
                      shades.dark,
                      `${side}-front-lower`,
                    )}
                    <Bone
                      name={`front${side}Paw` as DirectorBone}
                      {...boneProps}
                      position={[0, -lowerLeg, 0]}
                    >
                      {segment(
                        [0, 0.01, 0.035],
                        [legWidth * 1.1, 0.045, legWidth * 1.6],
                        shades.dark,
                        `${side}-front-paw`,
                      )}
                    </Bone>
                  </Bone>
                </Bone>
              ))}
            </Bone>
          </Bone>
          <Bone
            name="tail"
            {...boneProps}
            position={[0, bodyHeight * 0.2, -bodyLength * 0.18]}
          >
            {segment(
              [0, -bodyLength * 0.04, -bodyLength * 0.12],
              [bodyWidth * 0.16, bodyWidth * 0.16, bodyLength * 0.26],
              shades.base,
              "tail-mesh",
            )}
          </Bone>
          {[
            { side: "Left", x: bodyWidth * 0.42 },
            { side: "Right", x: -bodyWidth * 0.42 },
          ].map(({ side, x }) => (
            <Bone
              key={side}
              name={`rear${side}UpperLeg` as DirectorBone}
              {...boneProps}
              position={[x, 0, -bodyLength * 0.06]}
            >
              {segment(
                [0, -upperLeg / 2, 0],
                [legWidth, upperLeg, legWidth],
                shades.dark,
                `${side}-rear-upper`,
              )}
              <Bone
                name={`rear${side}LowerLeg` as DirectorBone}
                {...boneProps}
                position={[0, -upperLeg, 0]}
              >
                {segment(
                  [0, -lowerLeg / 2, 0],
                  [legWidth * 0.85, lowerLeg, legWidth * 0.85],
                  shades.dark,
                  `${side}-rear-lower`,
                )}
                <Bone
                  name={`rear${side}Paw` as DirectorBone}
                  {...boneProps}
                  position={[0, -lowerLeg, 0]}
                >
                  {segment(
                    [0, 0.01, 0.035],
                    [legWidth * 1.1, 0.045, legWidth * 1.6],
                    shades.dark,
                    `${side}-rear-paw`,
                  )}
                </Bone>
              </Bone>
            </Bone>
          ))}
        </Bone>
      </Bone>
    </group>
  );
}
