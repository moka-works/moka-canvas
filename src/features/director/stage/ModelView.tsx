import { useEffect, useState } from "react";
import {
  AnimationMixer,
  Bone,
  Box3,
  DoubleSide,
  FrontSide,
  LoopOnce,
  LoopRepeat,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector3,
  type AnimationAction,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { useThree } from "@react-three/fiber";
import { assetUrl } from "../../../api";
import {
  type DirectorHumanoidBone,
  type DirectorObject,
} from "../../../shared/domain";
import { boneRotation } from "./poses";
import { useRigNames } from "../stores/rigNames";

/** One animation a model brought with it, as its file states it. */
export interface ModelAnimation {
  name: string;
  duration: number;
}

interface LoadedModel {
  object: Object3D;
  mixer: AnimationMixer;
  actions: Record<string, AnimationAction>;
  bones: Record<string, Bone>;
  rest: Record<string, Quaternion>;
  /** False once the load that made it has been replaced or unmounted. */
  alive: boolean;
}

export interface ModelViewProps {
  object: DirectorObject;
  /** The time the shot is being drawn at. */
  time: number;
  onLoaded: (
    objectId: string,
    animations: ModelAnimation[],
    boneNames: string[],
  ) => void;
  onError: (objectId: string, message: string) => void;
  /** Bumped to ask every failed model to try again. */
  reloadToken: number;
}

/** Releases every geometry, material, and texture an imported model owns. */
function disposeModel(root: Object3D): void {
  const textures = new Set<{ dispose(): void }>();
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value && typeof value === "object" && "isTexture" in value) {
          textures.add(value as { dispose(): void });
        }
      }
      material.dispose();
    }
  });
  for (const texture of textures) texture.dispose();
}

/**
 * One imported model, normalised to the stage's metres.
 *
 * The file is cloned before it is touched, so an animation played on this
 * copy never moves another. Its skeleton is read once for the mapping UI,
 * and its bones are driven by the document: the selected animation first,
 * then pose or overrides on the joints the rig maps.
 */
export function ModelView({
  object,
  time,
  onLoaded,
  onError,
  reloadToken,
}: ModelViewProps) {
  const [model, setModel] = useState<LoadedModel | null>(null);
  const invalidate = useThree((state) => state.invalidate);
  const url = object.assetId ? assetUrl(object.assetId) : "";

  useEffect(() => {
    let cancelled = false;
    let built: Object3D | null = null;
    let mixer: AnimationMixer | null = null;
    let current: LoadedModel | null = null;
    setModel(null);
    if (!url) {
      onError(object.id, "No model asset is bound");
      return;
    }
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        if (cancelled) {
          disposeModel(gltf.scene);
          return;
        }
        const clone = cloneSkeleton(gltf.scene);
        built = clone;
        const box = new Box3().setFromObject(clone);
        const size = box.getSize(new Vector3());
        const longest = Math.max(size.x, size.y, size.z);
        const target = object.kind === "performer" ? 1.7 : 1.9;
        if (Number.isFinite(longest) && longest > 0) {
          clone.scale.multiplyScalar(target / longest);
        }
        clone.updateMatrixWorld(true);
        const fitted = new Box3().setFromObject(clone);
        const center = fitted.getCenter(new Vector3());
        clone.position.x -= center.x;
        clone.position.z -= center.z;
        clone.position.y -= fitted.min.y;
        clone.updateMatrixWorld(true);
        const bones: Record<string, Bone> = {};
        const rest: Record<string, Quaternion> = {};
        clone.traverse((child) => {
          if (!(child as Bone).isBone) return;
          const bone = child as Bone;
          bones[bone.name] = bone;
          rest[bone.name] = bone.quaternion.clone();
        });
        clone.traverse((child) => {
          const mesh = child as Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = object.castShadow;
          mesh.receiveShadow = object.receiveShadow;
          if (object.kind !== "performer") return;
          mesh.userData.directorActor = true;
          mesh.material = new MeshStandardMaterial({
            color: object.color,
            roughness: 0.75,
            metalness: 0.05,
          });
        });
        mixer = new AnimationMixer(clone);
        const actions: Record<string, AnimationAction> = {};
        for (const clip of gltf.animations) {
          actions[clip.name] = mixer.clipAction(clip);
        }
        current = {
          object: clone,
          mixer,
          actions,
          bones,
          rest,
          alive: true,
        };
        setModel(current);
        const boneNames = Object.keys(bones);
        useRigNames.getState().setBoneNames(object.id, boneNames);
        onLoaded(
          object.id,
          gltf.animations.map((clip) => ({
            name: clip.name,
            duration: clip.duration,
          })),
          boneNames,
        );
      },
      undefined,
      (error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        onError(object.id, message);
      },
    );
    return () => {
      cancelled = true;
      if (current) current.alive = false;
      mixer?.stopAllAction();
      if (built) disposeModel(built);
    };
    // The object's own material flags are applied on load; a colour change
    // reloads only for actors, where the colour is the material.
  }, [
    url,
    object.id,
    object.kind,
    object.color,
    object.castShadow,
    object.receiveShadow,
    onLoaded,
    onError,
    reloadToken,
  ]);

  useEffect(() => {
    if (!model || !model.alive) return;
    for (const action of Object.values(model.actions)) action.stop();
    const clip = object.motionClips?.find(
      (entry) => entry.id === object.activeMotionClipId,
    );
    const action = clip ? model.actions[clip.sourceAnimation] : undefined;
    if (clip && action) {
      action.reset();
      action.setLoop(clip.loop ? LoopRepeat : LoopOnce, Infinity);
      action.clampWhenFinished = !clip.loop;
      action.play();
      let local = Math.max(0, time - clip.start) * clip.playbackRate;
      if (clip.loop && clip.duration > 0) {
        local %= clip.duration;
      } else {
        local = Math.min(clip.duration, local);
      }
      model.mixer.setTime(local);
    } else {
      for (const [name, bone] of Object.entries(model.bones)) {
        const rest = model.rest[name];
        if (rest) bone.quaternion.copy(rest);
      }
    }
    for (const [bone, modelName] of Object.entries(object.rig?.boneMap ?? {})) {
      if (!modelName) continue;
      const target = model.bones[modelName];
      if (!target) continue;
      const delta = boneRotation(object, bone as DirectorHumanoidBone, time);
      const rest = model.rest[modelName];
      if (!delta || !rest) continue;
      const quaternion = new Quaternion(delta[0], delta[1], delta[2], delta[3]);
      target.quaternion.copy(rest).multiply(quaternion.normalize());
    }
    model.object.updateMatrixWorld(true);
    invalidate();
  }, [
    model,
    object.activeMotionClipId,
    object.motionClips,
    object.boneOverrides,
    object.boneTracks,
    object.pose,
    object.rig,
    time,
    invalidate,
  ]);

  if (!model) return null;
  return <primitive object={model.object} />;
}

/** A solid geometry whose parent group's scale is its size in metres. */
export function SolidView({ object }: { object: DirectorObject }) {
  const geometry = () => {
    switch (object.shape) {
      case "sphere":
        return <sphereGeometry args={[0.5, 32, 20]} />;
      case "cylinder":
        return <cylinderGeometry args={[0.5, 0.5, 1, 32]} />;
      case "plane":
        return <planeGeometry args={[1, 1]} />;
      default:
        return <boxGeometry args={[1, 1, 1]} />;
    }
  };
  return (
    <mesh castShadow={object.castShadow} receiveShadow={object.receiveShadow}>
      {geometry()}
      <meshStandardMaterial
        color={object.color}
        metalness={0.05}
        roughness={0.85}
        side={object.shape === "plane" ? DoubleSide : FrontSide}
      />
    </mesh>
  );
}

/** A picture standing in the stage as a backdrop. */
export function PlateView({
  object,
  onError,
}: {
  object: DirectorObject;
  onError: (objectId: string, message: string) => void;
}) {
  const [texture, setTexture] = useState<{ map: Texture } | null>(null);
  const url = object.assetId ? assetUrl(object.assetId) : "";

  useEffect(() => {
    let cancelled = false;
    let loaded: Texture | null = null;
    if (!url) return;
    new TextureLoader().load(
      url,
      (next) => {
        if (cancelled) {
          next.dispose();
          return;
        }
        next.colorSpace = SRGBColorSpace;
        loaded = next;
        setTexture({ map: next });
      },
      undefined,
      (error) => {
        if (cancelled) return;
        onError(
          object.id,
          error instanceof Error ? error.message : String(error),
        );
      },
    );
    return () => {
      cancelled = true;
      loaded?.dispose();
    };
  }, [url, object.id, onError]);

  return (
    <mesh castShadow={object.castShadow} receiveShadow={object.receiveShadow}>
      <planeGeometry args={[1, 1]} />
      {texture ? (
        <meshStandardMaterial
          map={texture.map}
          roughness={0.9}
          side={DoubleSide}
        />
      ) : (
        <meshStandardMaterial
          color={object.color}
          roughness={0.9}
          side={DoubleSide}
        />
      )}
    </mesh>
  );
}
