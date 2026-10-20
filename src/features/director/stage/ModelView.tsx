import { useEffect, useState } from "react";
import {
  Box3,
  DoubleSide,
  FrontSide,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector3,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { assetUrl } from "../../../api";
import type { DirectorObject } from "../../../shared/domain";

interface LoadedModel {
  object: Object3D;
  animationNames: string[];
}

export interface ModelViewProps {
  object: DirectorObject;
  onLoaded: (objectId: string, animationNames: string[]) => void;
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
 * A model is cloned before it is touched so an animation played on a clone
 * never moves a second copy, and the clone's own resources are released when
 * the object is removed, replaced, retried, or the room closes. A model that
 * will not load leaves the caller to draw a placeholder and say why.
 */
export function ModelView({
  object,
  onLoaded,
  onError,
  reloadToken,
}: ModelViewProps) {
  const [model, setModel] = useState<LoadedModel | null>(null);
  const url = object.assetId ? assetUrl(object.assetId) : "";

  useEffect(() => {
    let cancelled = false;
    let built: Object3D | null = null;
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
        const model = cloneSkeleton(gltf.scene);
        built = model;
        const box = new Box3().setFromObject(model);
        const size = box.getSize(new Vector3());
        const longest = Math.max(size.x, size.y, size.z);
        const target = object.kind === "performer" ? 1.7 : 1.9;
        if (Number.isFinite(longest) && longest > 0) {
          model.scale.multiplyScalar(target / longest);
        }
        model.updateMatrixWorld(true);
        const fitted = new Box3().setFromObject(model);
        const center = fitted.getCenter(new Vector3());
        model.position.x -= center.x;
        model.position.z -= center.z;
        model.position.y -= fitted.min.y;
        model.updateMatrixWorld(true);
        model.traverse((child) => {
          const mesh = child as Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = object.castShadow;
          mesh.receiveShadow = object.receiveShadow;
          if (object.kind !== "performer") return;
          mesh.userData.directorActor = true;
          const material = new MeshStandardMaterial({
            color: object.color,
            roughness: 0.75,
            metalness: 0.05,
          });
          mesh.material = material;
        });
        setModel({
          object: model,
          animationNames: gltf.animations.map((clip) => clip.name),
        });
        onLoaded(
          object.id,
          gltf.animations.map((clip) => clip.name),
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
