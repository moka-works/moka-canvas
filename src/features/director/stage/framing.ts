import type {
  DirectorAspectRatio,
  DirectorCamera,
  DirectorScene,
} from "../../../shared/domain";

/** The width over the height a shot's frame is. */
export function aspectValue(aspect: DirectorAspectRatio | string): number {
  const parts = aspect.split(":");
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return 16 / 9;
  }
  return width / height;
}

/** The 35mm full-frame horizontal field of view a focal length sees. */
export function horizontalFov(focalLength: number): number {
  return 2 * Math.atan(36 / (2 * focalLength));
}

/**
 * The vertical field of view for a focal length and a frame.
 *
 * Three.js states a perspective camera's fov vertically, while a lens is
 * named by its horizontal view: the conversion is what keeps the same lens
 * seeing the same width in every frame shape.
 */
export function verticalFov(focalLength: number, aspect: number): number {
  const horizontal = horizontalFov(focalLength);
  return (
    2 * Math.atan(Math.tan(horizontal / 2) / (aspect > 0 ? aspect : 16 / 9))
  );
}

/** The pixel size a shot is delivered at, from its long edge. */
export function outputSize(
  aspect: DirectorAspectRatio | string,
  longEdge = 1920,
): { width: number; height: number } {
  const ratio = aspectValue(aspect);
  if (ratio >= 1) {
    return { width: longEdge, height: Math.round(longEdge / ratio) };
  }
  return { width: Math.round(longEdge * ratio), height: longEdge };
}

/**
 * The largest rectangle of a given shape that fits a container, centred.
 *
 * The CAM view uses this to draw the frame inside whatever the window is:
 * the picture is the shot's shape, and the rest of the viewport is masked
 * rather than stretched into.
 */
export function fitAspectRect(
  width: number,
  height: number,
  aspect: number,
): { x: number; y: number; width: number; height: number } {
  if (!(width > 0) || !(height > 0)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const ratio = aspect > 0 ? aspect : 16 / 9;
  const frameWidth = Math.min(width, height * ratio);
  const frameHeight = frameWidth / ratio;
  return {
    x: (width - frameWidth) / 2,
    y: (height - frameHeight) / 2,
    width: frameWidth,
    height: frameHeight,
  };
}

/** An axis-aligned box in the stage's own coordinates. */
export interface StageBounds {
  center: [number, number, number];
  span: [number, number, number];
}

/**
 * The box the five orthographic views frame: every object's rough volume
 * plus each camera and light position. Each axis is at least two metres so a
 * nearly empty scene is not zoomed into a speck.
 */
export function stageBounds(scene: DirectorScene): StageBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const stretch = (x: number, y: number, z: number) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  };
  for (const object of scene.objects) {
    const [x, y, z] = object.transform.position;
    const [sx, sy, sz] = object.transform.scale;
    const height =
      object.kind === "performer"
        ? (object.actorBuild?.stature ??
          object.animalBuild?.shoulderHeight ??
          1.7)
        : Math.abs(sy);
    const width = object.kind === "performer" ? 0.5 : Math.abs(sx);
    const depth = object.kind === "performer" ? 0.5 : Math.abs(sz);
    stretch(x - width / 2, y, z - depth / 2);
    stretch(x + width / 2, y + height, z + depth / 2);
  }
  for (const camera of scene.cameras) {
    stretch(...camera.transform.position);
    stretch(...camera.target);
  }
  for (const light of scene.lights) {
    stretch(...light.transform.position);
  }
  if (!Number.isFinite(minX)) {
    return { center: [0, 1, 0], span: [6, 3, 6] };
  }
  return {
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    span: [
      Math.max(2, maxX - minX),
      Math.max(2, maxY - minY),
      Math.max(2, maxZ - minZ),
    ],
  };
}

/**
 * The half-ranges an orthographic camera covers for one view.
 *
 * A wide subject has to fit across and a tall one up, so each half-range is
 * the larger of what its own span needs and what the other span needs at this
 * viewport's shape. Without the second term a wide scene in a tall window is
 * cropped rather than framed.
 */
export function orthographicHalfRanges(
  spanX: number,
  spanY: number,
  aspect: number,
): { halfWidth: number; halfHeight: number } {
  const ratio = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const paddedX = spanX * 1.2;
  const paddedY = spanY * 1.2;
  const halfWidth = Math.max(paddedX / 2, (paddedY / 2) * ratio);
  const halfHeight = Math.max(paddedY / 2, paddedX / 2 / ratio);
  return { halfWidth, halfHeight };
}

/** The distance an orthographic view stands back from its subject. */
export function orthographicDistance(span: StageBounds): number {
  const radius = Math.hypot(span.span[0], span.span[1], span.span[2]) / 2;
  return Math.max(radius * 2, 2);
}

/**
 * Whether a camera's own numbers can be handed to Three.js without producing
 * a corrupt matrix. A caller with a broken camera falls back to the free one.
 */
export function cameraUsable(camera: DirectorCamera): boolean {
  return (
    Number.isFinite(camera.focalLength) &&
    camera.focalLength > 0 &&
    Number.isFinite(camera.near) &&
    camera.near > 0 &&
    Number.isFinite(camera.far) &&
    camera.far > camera.near &&
    camera.transform.position.every((axis) => Number.isFinite(axis)) &&
    camera.target.every((axis) => Number.isFinite(axis))
  );
}
