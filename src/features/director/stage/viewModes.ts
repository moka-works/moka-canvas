/** The seven ways the viewport can look at a scene. */
export type DirectorView =
  "free" | "camera" | "top" | "front" | "back" | "left" | "right";

export const DIRECTOR_VIEWS: readonly DirectorView[] = [
  "free",
  "camera",
  "top",
  "front",
  "back",
  "left",
  "right",
];

/** The views an orthographic camera draws. */
export const ORTHO_VIEWS: readonly DirectorView[] = [
  "top",
  "front",
  "back",
  "left",
  "right",
];

/** Where each orthographic view stands, as a unit direction from its centre. */
export const ORTHO_DIRECTIONS: Record<
  "top" | "front" | "back" | "left" | "right",
  [number, number, number]
> = {
  // Looking down: the top view stands above the stage and up is −Z, so the
  // picture reads like a plan with the front of the stage at the bottom.
  top: [0, 1, 0.0001],
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
};

export function isOrthoView(view: DirectorView): boolean {
  return ORTHO_VIEWS.includes(view);
}

/** The short word the viewport corner shows. */
export function viewLabel(view: DirectorView): string {
  switch (view) {
    case "free":
      return "3D";
    case "camera":
      return "CAM";
    case "top":
      return "TOP";
    case "front":
      return "FRONT";
    case "back":
      return "BACK";
    case "left":
      return "LEFT";
    case "right":
      return "RIGHT";
  }
}
