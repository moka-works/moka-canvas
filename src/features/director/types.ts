import type { DirectorRenderMode } from "../../shared/domain";
import type { DirectorView } from "./stage/viewModes";

/** The four ways the desk is worked in. */
export type DirectorMode = "stage" | "perform" | "motion" | "lens";

/** What the transform gizmo moves. */
export type DirectorTransformMode = "translate" | "rotate" | "scale";

/** What is selected in the viewport. */
export interface DirectorSelection {
  kind: "object" | "camera" | "light";
  id: string;
}

export interface DirectorPlacement {
  mode: DirectorMode;
  view: DirectorView;
  renderMode: DirectorRenderMode;
  transformMode: DirectorTransformMode;
  selection: DirectorSelection | null;
}

/** An upstream picture wired into the desk's plates input. */
export interface DirectorPlate {
  nodeId: string;
  title: string;
  assetId?: string;
}

/** The navigation the dock asks of the free camera. */
export interface DirectorViewportApi {
  focusSelection: () => void;
  fitAll: () => void;
  resetView: () => void;
  dolly: (factor: number) => void;
}
