import {
  ACESFilmicToneMapping,
  BasicDepthPacking,
  Color,
  Mesh,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshNormalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  SRGBColorSpace,
  WebGLRenderer,
  WebGLRenderTarget,
  type Material,
  type Object3D,
  type Scene,
  type Texture,
  Vector4,
} from "three";
import type {
  DirectorCamera,
  DirectorObject,
  DirectorRenderMode,
  DirectorScene,
  DirectorShot,
} from "../../../shared/domain";
import { RECORDING_MIME_TYPES } from "../capabilities";
import { placeShotCamera } from "./StageWorld";
import { sampleTransform } from "./animation";
import { outputSize, verticalFov } from "./framing";
import { boneRotationOrIdentity } from "./poses";

const RECORD_BITRATE = 8_000_000;

export type DirectorCaptureResolution = 1280 | 1920 | 3840;

export interface CaptureContext {
  gl: WebGLRenderer;
  scene: Scene;
  /** Redraws the visible viewport after a capture has put the scene back. */
  invalidate: () => void;
}

/** Something changed for a capture, to be put back exactly. */
interface SceneRestore {
  restore: () => void;
}

function hideHelpers(scene: Object3D): SceneRestore {
  const hidden: { object: Object3D; visible: boolean }[] = [];
  scene.traverse((object) => {
    if (object.userData?.directorHelper) {
      hidden.push({ object, visible: object.visible });
      object.visible = false;
    }
  });
  return {
    restore: () => {
      for (const entry of hidden) entry.object.visible = entry.visible;
    },
  };
}

function paintMode(scene: Object3D, mode: DirectorRenderMode): SceneRestore {
  if (mode === "lit") return { restore: () => undefined };
  if (mode === "blockout") {
    const blockout = new MeshStandardMaterial({
      color: "#aeb5bf",
      metalness: 0.02,
      roughness: 0.85,
    });
    const changed: { mesh: Mesh; material: Material | Material[] }[] = [];
    const under = (object: Object3D | null, flag: string): boolean => {
      let current = object;
      while (current) {
        if (current.userData?.[flag]) return true;
        current = current.parent;
      }
      return false;
    };
    scene.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      if (under(mesh, "directorHelper") || under(mesh, "directorActor")) return;
      const material = mesh.material as Material & { uniforms?: unknown };
      if (!material || material.uniforms) return;
      changed.push({ mesh, material: mesh.material });
      mesh.material = blockout;
    });
    return {
      restore: () => {
        for (const entry of changed) entry.mesh.material = entry.material;
        blockout.dispose();
      },
    };
  }
  const material =
    mode === "normal"
      ? new MeshNormalMaterial()
      : mode === "silhouette"
        ? new MeshBasicMaterial({ color: "#ffffff" })
        : new MeshDepthMaterial({ depthPacking: BasicDepthPacking });
  material.toneMapped = false;
  const sceneMesh = scene as unknown as {
    overrideMaterial?: Material | null;
  };
  const previous = sceneMesh.overrideMaterial ?? null;
  sceneMesh.overrideMaterial = material;
  return {
    restore: () => {
      sceneMesh.overrideMaterial = previous;
      material.dispose();
    },
  };
}

function paintBackground(
  scene: Object3D,
  mode: DirectorRenderMode,
): SceneRestore {
  if (mode === "lit") return { restore: () => undefined };
  const sceneObject = scene as unknown as {
    background?: Color | Texture | null;
  };
  const background = sceneObject.background ?? null;
  sceneObject.background = new Color("#000000");
  return {
    restore: () => {
      sceneObject.background = background;
    },
  };
}

function shotCamera(
  sceneDocument: DirectorScene,
  shot: DirectorShot,
  time: number,
): DirectorCamera | undefined {
  const camera = sceneDocument.cameras.find(
    (entry) => entry.id === shot.cameraId,
  );
  if (!camera) return undefined;
  return {
    ...camera,
    transform: sampleTransform(camera.keyframes, time) ?? camera.transform,
  };
}

function placeCamera(
  camera: PerspectiveCamera,
  data: DirectorCamera,
  aspect: number,
): void {
  if (!placeShotCamera(camera, data, aspect)) {
    throw new Error("The shot's camera values cannot be used");
  }
  camera.aspect = aspect;
  camera.fov = (verticalFov(data.focalLength, aspect) * 180) / Math.PI;
  camera.updateProjectionMatrix();
}

function pngFromPixels(
  width: number,
  height: number,
  pixels: Uint8Array,
): Promise<Blob> {
  const flipped = new Uint8ClampedArray(pixels.length);
  const stride = width * 4;
  for (let row = 0; row < height; row += 1) {
    const from = (height - 1 - row) * stride;
    flipped.set(pixels.subarray(from, from + stride), row * stride);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("A 2D canvas could not be created for the frame");
  context.putImageData(new ImageData(flipped, width, height), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The browser did not encode the frame as PNG"));
    }, "image/png");
  });
}

/**
 * One shot's frame, rendered offscreen at the shot's own shape.
 *
 * The visible viewport may carry masks, guides, and a window-shaped frame;
 * none of that reaches the file. Helpers and the grid are hidden, the chosen
 * render mode is applied, and the camera is built from the shot's lens and
 * framing alone.
 */
export async function captureFrame(
  context: CaptureContext,
  sceneDocument: DirectorScene,
  shot: DirectorShot,
  mode: DirectorRenderMode,
  resolution: DirectorCaptureResolution,
  time: number,
): Promise<Blob> {
  const { width, height } = outputSize(shot.aspectRatio, resolution);
  const cameraData = shotCamera(sceneDocument, shot, time);
  if (!cameraData) throw new Error("The active shot has no camera");
  const camera = new PerspectiveCamera();
  placeCamera(camera, cameraData, width / height);

  const gl = context.gl;
  const previousTarget = gl.getRenderTarget();
  const previousViewport = gl.getViewport(new Vector4());
  const previousScissor = gl.getScissor(new Vector4());
  const previousScissorTest = gl.getScissorTest();
  const previousClear = gl.getClearColor(new Color());
  const previousAlpha = gl.getClearAlpha();
  const helpers = hideHelpers(context.scene);
  const painted = paintMode(context.scene, mode);
  const background = paintBackground(context.scene, mode);
  const target = new WebGLRenderTarget(width, height, { samples: 4 });
  target.texture.colorSpace = SRGBColorSpace;
  try {
    gl.setRenderTarget(target);
    gl.setViewport(0, 0, width, height);
    gl.setScissorTest(false);
    gl.setClearColor(0x000000, 1);
    gl.clear(true, true, true);
    gl.render(context.scene, camera);
    const pixels = new Uint8Array(width * height * 4);
    gl.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    return await pngFromPixels(width, height, pixels);
  } finally {
    gl.setRenderTarget(previousTarget);
    gl.setViewport(previousViewport);
    gl.setScissor(previousScissor);
    gl.setScissorTest(previousScissorTest);
    gl.setClearColor(previousClear, previousAlpha);
    background.restore();
    painted.restore();
    helpers.restore();
    context.invalidate();
    target.dispose();
  }
}

function objectGroups(scene: Object3D): Map<string, Object3D> {
  const groups = new Map<string, Object3D>();
  scene.traverse((object) => {
    const id = object.userData?.directorObjectId;
    if (typeof id === "string") groups.set(id, object);
  });
  return groups;
}

function applySceneTime(
  scene: Object3D,
  sceneDocument: DirectorScene,
  shot: DirectorShot,
  time: number,
  camera: PerspectiveCamera,
): void {
  const groups = objectGroups(scene);
  for (const object of sceneDocument.objects) {
    const group = groups.get(object.id);
    if (!group) continue;
    const transform =
      sampleTransform(object.keyframes, time) ?? object.transform;
    group.position.set(...transform.position);
    group.rotation.set(...transform.rotation);
    group.scale.set(...transform.scale);
    const sample = group.userData?.directorSample as
      ((next: DirectorObject, at: number) => void) | undefined;
    if (sample) {
      sample(object, time);
      continue;
    }
    group.traverse((child) => {
      if (!child.name) return;
      if (!(child as { isGroup?: boolean }).isGroup) return;
      const rotation = boneRotationOrIdentity(
        object,
        child.name as Parameters<typeof boneRotationOrIdentity>[1],
        time,
      );
      child.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]);
    });
  }
  const data = shotCamera(sceneDocument, shot, time);
  if (data) placeCamera(camera, data, outputAspect(shot));
  scene.updateMatrixWorld(true);
}

function outputAspect(shot: DirectorShot): number {
  const [width, height] = shot.aspectRatio.split(":").map(Number);
  return width > 0 && height > 0 ? width / height : 16 / 9;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function recordingMime(): string {
  if (typeof MediaRecorder === "undefined") {
    throw new Error(
      "This browser or desktop view has no MediaRecorder, so a blocking reference cannot be recorded",
    );
  }
  for (const type of RECORDING_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  throw new Error(
    "This browser supports MediaRecorder but none of its WebM video encodings",
  );
}

/**
 * Reads a recorded blob's length by asking a video element for its metadata.
 *
 * A WebM written by MediaRecorder may report an infinite duration until the
 * file is seeked past its end; the seek is what makes the browser finish the
 * header, and only then is the length trustworthy.
 */
export function blobDuration(blob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(blob);
    const finish = (value: number) => {
      URL.revokeObjectURL(url);
      video.remove();
      resolve(value);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        finish(video.duration);
        return;
      }
      video.currentTime = 1e6;
    };
    video.ontimeupdate = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        finish(video.duration);
      }
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      video.remove();
      reject(
        new Error("The recorded blocking reference could not be read back"),
      );
    };
    video.src = url;
  });
}

/**
 * Records the shot's blockout as the shot plays.
 *
 * A renderer of its own draws into a canvas of the frame's exact size, so the
 * viewport is left alone and no mask or panel is recorded. The scene is moved
 * through the shot in real time because MediaRecorder stamps frames by wall
 * clock, then put back at the playhead the reader was on.
 */
export async function recordBlocking(
  context: CaptureContext,
  sceneDocument: DirectorScene,
  shot: DirectorShot,
  resolution: DirectorCaptureResolution,
  playhead: number,
): Promise<{ blob: Blob; mime: string }> {
  const mime = recordingMime();
  if (typeof HTMLCanvasElement.prototype.captureStream !== "function") {
    throw new Error("This browser cannot capture a canvas as a video stream");
  }
  const { width, height } = outputSize(shot.aspectRatio, resolution);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  const camera = new PerspectiveCamera();
  const helpers = hideHelpers(context.scene);
  const painted = paintMode(context.scene, "blockout");
  const chunks: Blob[] = [];
  let recorder: MediaRecorder | null = null;
  try {
    applySceneTime(context.scene, sceneDocument, shot, 0, camera);
    const stream = canvas.captureStream(shot.fps);
    recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: RECORD_BITRATE,
    });
    const stopped = new Promise<void>((resolve) => {
      if (!recorder) return resolve();
      recorder.onstop = () => resolve();
    });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.start(250);
    const start = performance.now();
    const frameMs = 1000 / shot.fps;
    const frames = Math.ceil(shot.duration * shot.fps) + 1;
    for (let index = 0; index < frames; index += 1) {
      const time = Math.min(shot.duration, index / shot.fps);
      applySceneTime(context.scene, sceneDocument, shot, time, camera);
      renderer.render(context.scene, camera);
      const wait = start + (index + 1) * frameMs - performance.now();
      if (wait > 0) await delay(wait);
    }
    await delay(120);
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunks, { type: mime });
    if (blob.size === 0) {
      throw new Error("The recorder produced no video");
    }
    const duration = await blobDuration(blob);
    if (duration < Math.max(0.25, shot.duration * 0.5)) {
      throw new Error(
        `The blocking reference is ${duration.toFixed(2)} seconds long; the shot is ${shot.duration} seconds`,
      );
    }
    return { blob, mime };
  } finally {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    applySceneTime(context.scene, sceneDocument, shot, playhead, camera);
    painted.restore();
    helpers.restore();
    context.invalidate();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  }
}
