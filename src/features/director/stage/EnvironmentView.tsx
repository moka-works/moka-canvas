import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import {
  Color,
  EquirectangularReflectionMapping,
  PMREMGenerator,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  type WebGLRenderTarget,
} from "three";
import { assetUrl } from "../../../api";
import type { DirectorEnvironment } from "../../../shared/domain";

export interface EnvironmentViewProps {
  background: string;
  environmentIntensity: number;
  environment?: DirectorEnvironment;
  onError: (message: string) => void;
}

/**
 * The colour or picture behind the stage, and optionally the light it gives.
 *
 * A panorama is read as an equirectangular picture by the same URL the rest
 * of the app uses, so nothing leaves the project folder. A picture that will
 * not load falls back to the background colour and says so; the stage stays
 * usable rather than going black without explanation.
 */
export function EnvironmentView({
  background,
  environmentIntensity,
  environment,
  onError,
}: EnvironmentViewProps) {
  const { gl, scene, invalidate } = useThree();

  useEffect(() => {
    let disposed = false;
    let texture: Texture | null = null;
    let target: WebGLRenderTarget | null = null;
    let pmrem: PMREMGenerator | null = null;
    scene.environment = null;
    scene.environmentIntensity = environmentIntensity;

    if (environment?.mode !== "panorama" || !environment.assetId) {
      scene.background = new Color(background);
      invalidate();
      return () => {
        disposed = true;
        scene.background = null;
      };
    }

    const loader = new TextureLoader();
    loader.load(
      assetUrl(environment.assetId),
      (loaded) => {
        if (disposed) {
          loaded.dispose();
          return;
        }
        texture = loaded;
        loaded.colorSpace = SRGBColorSpace;
        loaded.mapping = EquirectangularReflectionMapping;
        loaded.rotation = environment.rotationY ?? 0;
        scene.background = loaded;
        if (environment.useAsLighting) {
          pmrem = new PMREMGenerator(gl);
          target = pmrem.fromEquirectangular(loaded);
          scene.environment = target.texture;
          scene.environmentIntensity =
            environment.lightingIntensity ?? environmentIntensity;
        }
        invalidate();
      },
      undefined,
      (error) => {
        if (disposed) return;
        scene.background = new Color(background);
        invalidate();
        onError(error instanceof Error ? error.message : String(error));
      },
    );

    return () => {
      disposed = true;
      if (scene.background === texture) scene.background = null;
      if (scene.environment === target?.texture) scene.environment = null;
      target?.dispose();
      pmrem?.dispose();
      texture?.dispose();
      scene.background = null;
      scene.environment = null;
    };
  }, [
    background,
    environment,
    environmentIntensity,
    gl,
    invalidate,
    onError,
    scene,
  ]);

  return null;
}
