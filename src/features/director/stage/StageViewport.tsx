import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { useTranslation } from "react-i18next";
import * as THREE from "three";
import {
  activeShotOf,
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
import { StageWorld } from "./StageWorld";
import { aspectValue, fitAspectRect } from "./framing";
import type { ModelAnimation } from "./ModelView";
import type { DirectorView } from "./viewModes";

/**
 * The rendering settings the viewport starts from.
 *
 * Kept at module level so the canvas does not see a new object on every
 * render: a fresh camera or renderer configuration is a fresh renderer.
 */
const CAMERA_CONFIG = {
  position: [6.0, 2.6, 7.8] as [number, number, number],
  fov: 32,
  near: 0.08,
  far: 400,
};

const GL_CONFIG = {
  antialias: true,
  alpha: false,
  // Reading a frame back needs the buffer that was just drawn. Only this
  // room pays for it; the rest of the app never creates a 3D context.
  preserveDrawingBuffer: true,
};

/** What capture and recording need from the live renderer. */
export interface DirectorCaptureContext {
  gl: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
}

export interface StageViewportProps {
  scene: DirectorScene;
  view: DirectorView;
  renderMode: DirectorRenderMode;
  transformMode: DirectorTransformMode;
  selection: DirectorSelection | null;
  onSelect: (selection: DirectorSelection | null) => void;
  onCaptureContext?: (context: DirectorCaptureContext | null) => void;
  onCameraFallback?: (reason: string) => void;
  /** Called when a model's own animations and skeleton names become known. */
  onModelLoaded?: (
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
  onPathComplete: (points: import("./animation").PathPoint[]) => void;
  onPathCancel: () => void;
  guides: { safeFrames: boolean; thirds: boolean; centerCross: boolean };
  apiRef?: { current: DirectorViewportApi | null };
}

function CaptureBridge({
  onContext,
}: {
  onContext: (context: DirectorCaptureContext | null) => void;
}) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    onContext({ gl, scene, camera });
    return () => onContext(null);
  }, [gl, scene, camera, onContext]);
  return null;
}

function InvalidateOnScene({ scene }: { scene: DirectorScene }) {
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    invalidate();
  }, [scene, invalidate]);
  return null;
}

/**
 * The one place in the app a WebGL renderer is created.
 *
 * The renderer is remounted only when the reader asks to rebuild it after a
 * lost context; a lost context does not unmount the Canvas on its own, which
 * would throw away the scene the reader is working on.
 */
export function StageViewport({
  scene,
  view,
  renderMode,
  transformMode,
  selection,
  onSelect,
  onCaptureContext,
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
  guides,
  apiRef,
}: StageViewportProps) {
  const { t } = useTranslation("director");
  const [ready, setReady] = useState(false);
  const [lost, setLost] = useState(false);
  const [renderKey, setRenderKey] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [modelErrors, setModelErrors] = useState<Map<string, string>>(
    new Map(),
  );
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () =>
      setSize({ width: root.clientWidth, height: root.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const reportModelError = useCallback((objectId: string, message: string) => {
    setModelErrors((held) => {
      if (held.get(objectId) === message) return held;
      const next = new Map(held);
      next.set(objectId, message);
      return next;
    });
  }, []);
  const reportEnvironmentError = useCallback(
    (message: string) => setEnvironmentError(message),
    [],
  );
  const reportCameraFallback = useCallback(
    (reason: string) => {
      setFallback(reason);
      onCameraFallback?.(reason);
    },
    [onCameraFallback],
  );
  const reportLoaded = useCallback(
    (objectId: string, animations: ModelAnimation[], boneNames: string[]) => {
      setModelErrors((held) => {
        if (!held.has(objectId)) return held;
        const next = new Map(held);
        next.delete(objectId);
        return next;
      });
      onModelLoaded?.(objectId, animations, boneNames);
    },
    [onModelLoaded],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onLost = (event: Event) => {
      // Without preventDefault the browser will not send `restored`.
      event.preventDefault();
      setLost(true);
      onCaptureContext?.(null);
    };
    const onRestored = () => setLost(false);
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    };
  }, [onCaptureContext, renderKey, ready]);

  const errors = useMemo(() => [...modelErrors.values()], [modelErrors]);

  return (
    <div
      className="director-viewport"
      data-renderer-ready={ready && !lost ? "true" : "false"}
      ref={rootRef}
    >
      <Canvas
        camera={CAMERA_CONFIG}
        dpr={[1, 1.5]}
        frameloop="demand"
        gl={GL_CONFIG}
        key={renderKey}
        onCreated={({ gl, invalidate }) => {
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1;
          gl.shadowMap.enabled = true;
          gl.shadowMap.type = THREE.PCFSoftShadowMap;
          canvasRef.current = gl.domElement;
          setReady(true);
          invalidate();
        }}
        onPointerMissed={() => onSelect(null)}
        shadows
      >
        <InvalidateOnScene scene={scene} />
        <StageWorld
          apiRef={apiRef}
          onBonePreview={onBonePreview}
          onCameraFallback={reportCameraFallback}
          onEnvironmentError={reportEnvironmentError}
          onGestureEnd={onGestureEnd}
          onGestureStart={onGestureStart}
          onGroundPoint={onGroundPoint}
          onModelError={reportModelError}
          onModelLoaded={reportLoaded}
          onPathCancel={onPathCancel}
          onPathComplete={onPathComplete}
          onSelect={onSelect}
          onTransformPreview={onTransformPreview}
          pathMode={pathMode}
          playhead={playhead}
          reloadToken={reloadToken}
          renderMode={renderMode}
          scene={scene}
          selection={selection}
          showTracks={showTracks}
          transformMode={transformMode}
          view={view}
        />
        <CaptureBridge onContext={(context) => onCaptureContext?.(context)} />
      </Canvas>
      {view !== "free" && (
        <span className="director-view-label">
          {t(`director:view.${view}`)}
        </span>
      )}
      {view === "camera" &&
        (() => {
          const shot = activeShotOf(scene);
          if (!shot) return null;
          const frame = fitAspectRect(
            size.width,
            size.height,
            aspectValue(shot.aspectRatio),
          );
          if (frame.width <= 0 || frame.height <= 0) return null;
          return (
            <div
              aria-hidden="true"
              className="director-cam-guides"
              style={{
                left: frame.x,
                top: frame.y,
                width: frame.width,
                height: frame.height,
              }}
            >
              {guides.safeFrames && (
                <>
                  <span className="director-safe is-action" />
                  <span className="director-safe is-title" />
                </>
              )}
              {guides.thirds && (
                <>
                  <span className="director-thirds is-v1" />
                  <span className="director-thirds is-v2" />
                  <span className="director-thirds is-h1" />
                  <span className="director-thirds is-h2" />
                </>
              )}
              {guides.centerCross && (
                <>
                  <span className="director-cross is-h" />
                  <span className="director-cross is-v" />
                </>
              )}
            </div>
          );
        })()}
      {lost && (
        <div className="director-viewport-error" role="alert">
          <strong>{t("director:contextLost.title")}</strong>
          <p>{t("director:contextLost.body")}</p>
          <button
            className="button"
            onClick={() => {
              setLost(false);
              setReady(false);
              setRenderKey((held) => held + 1);
            }}
            type="button"
          >
            {t("director:contextLost.rebuild")}
          </button>
        </div>
      )}
      {!lost && errors.length > 0 && (
        <details className="director-viewport-notice" role="status">
          <summary>
            {t("director:modelLoad.failed", { count: errors.length })}
          </summary>
          <pre>{errors.join("\n")}</pre>
          <button
            className="button"
            onClick={() => {
              setModelErrors(new Map());
              setReloadToken((held) => held + 1);
            }}
            type="button"
          >
            {t("director:modelLoad.retry")}
          </button>
        </details>
      )}
      {!lost && environmentError && (
        <details className="director-viewport-notice is-warning" role="status">
          <summary>{t("director:environment.failed")}</summary>
          <pre>{environmentError}</pre>
          <button
            className="button"
            onClick={() => {
              setEnvironmentError(null);
              setReloadToken((held) => held + 1);
            }}
            type="button"
          >
            {t("director:environment.retry")}
          </button>
        </details>
      )}
      {fallback && (
        <p className="director-viewport-fallback" role="status">
          {t("director:view.fallback")}
          <button
            aria-label={t("director:view.dismiss")}
            className="director-viewport-dismiss"
            onClick={() => setFallback(null)}
            type="button"
          >
            ×
          </button>
        </p>
      )}
    </div>
  );
}
