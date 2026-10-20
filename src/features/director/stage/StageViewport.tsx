import { Canvas, useThree } from "@react-three/fiber";
import { Grid, OrbitControls } from "@react-three/drei";
import { useState, type ReactElement } from "react";
import * as THREE from "three";

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

/** The dark stage the room is built on, independent of the UI theme. */
const STAGE_BACKGROUND = "#202630";
const STAGE_FLOOR = "#39414c";

function Controls() {
  const invalidate = useThree((state) => state.invalidate);
  return (
    <OrbitControls
      makeDefault
      dampingFactor={0.08}
      rotateSpeed={0.7}
      panSpeed={0.85}
      zoomSpeed={0.85}
      minDistance={0.35}
      maxDistance={80}
      onChange={() => invalidate()}
    />
  );
}

function EmptyStage(): ReactElement {
  return (
    <>
      <color attach="background" args={[STAGE_BACKGROUND]} />
      <ambientLight intensity={0.55} color="#ffffff" />
      <directionalLight
        castShadow
        position={[5, 8, 5]}
        intensity={2.6}
        color="#fff1e0"
        shadow-mapSize={[1024, 1024]}
      />
      <directionalLight
        position={[-6, 5, -4]}
        intensity={1.2}
        color="#d9e7ff"
      />
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[120, 120]} />
        <meshStandardMaterial
          color={STAGE_FLOOR}
          roughness={0.95}
          metalness={0}
        />
      </mesh>
      <Grid
        position={[0, 0.001, 0]}
        args={[120, 120]}
        cellSize={0.25}
        cellThickness={0.5}
        cellColor="#5a6472"
        sectionSize={2}
        sectionThickness={1}
        sectionColor="#788391"
        fadeDistance={48}
        fadeStrength={1.5}
        infiniteGrid
      />
      <Controls />
    </>
  );
}

export interface StageViewportProps {
  /** Called once the renderer exists and the first frame is on its way. */
  onReady?: () => void;
}

/**
 * The one place in the app a WebGL renderer is created.
 *
 * Everything that needs to reach the renderer — capture, recording, camera
 * probing — is added here rather than climbing in from a sibling, so the
 * lifecycle of the context has a single owner.
 */
export function StageViewport({ onReady }: StageViewportProps) {
  const [ready, setReady] = useState(false);
  return (
    <div
      className="director-viewport"
      data-renderer-ready={ready ? "true" : "false"}
    >
      <Canvas
        shadows
        frameloop="demand"
        dpr={[1, 1.5]}
        camera={CAMERA_CONFIG}
        gl={GL_CONFIG}
        onCreated={({ gl, invalidate }) => {
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1;
          gl.shadowMap.enabled = true;
          gl.shadowMap.type = THREE.PCFSoftShadowMap;
          setReady(true);
          invalidate();
          onReady?.();
        }}
      >
        <EmptyStage />
      </Canvas>
    </div>
  );
}
