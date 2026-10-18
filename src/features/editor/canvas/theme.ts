/** Everything a canvas paints itself with. */
export interface CanvasPalette {
  background: string;
  grid: string;
  nodeFill: string;
  nodeStroke: string;
  nodeTitle: string;
  nodeMuted: string;
  /** The wash under a card, which keeps it off the background behind it. */
  nodeShadow: string;
  /** What a group's frame is filled with, faintly enough to see through. */
  groupFill: string;
  /** The wash behind a picture that is missing, changed, or empty. */
  alertFill: string;
  progressTrack: string;
  selection: string;
  edge: string;
  edgeSelected: string;
  edgeRelated: string;
  port: string;
  portCompatible: string;
  portRejected: string;
  /** Node card status dot per run step status. */
  runStatus: Record<string, string>;
  marquee: string;
  marqueeFill: string;
  snapGuide: string;
  minimapFill: string;
  minimapViewport: string;
  kindAccent: Record<string, string>;
  fontFamily: string;
}

export type CanvasThemeName = "graphite" | "paper";

export const CANVAS_THEME_NAMES: readonly CanvasThemeName[] = [
  "graphite",
  "paper",
];

/** What each theme is called on the button that chooses it. */
export const CANVAS_THEME_LABELS: Record<CanvasThemeName, string> = {
  graphite: "editor:theme.graphite",
  paper: "editor:theme.paper",
};

export const CANVAS_THEMES: Record<CanvasThemeName, CanvasPalette> = {
  /** The dark palette the editor was born in, aligned with tokens.css. */
  graphite: {
    background: "#0d0d10",
    grid: "#26272d",
    nodeFill: "#17181d",
    nodeStroke: "#2c2e35",
    nodeTitle: "#f4f4f6",
    nodeMuted: "#9a9aa4",
    nodeShadow: "#00000066",
    groupFill: "#ffffff08",
    alertFill: "#2a1e21",
    progressTrack: "#ffffff14",
    selection: "#f5f5f7",
    edge: "#bfc0c8",
    edgeSelected: "#ffffff",
    edgeRelated: "#e8e8ec",
    port: "#9a9aa4",
    portCompatible: "#7ee2a8",
    portRejected: "#ff8a80",
    runStatus: {
      queued: "#f2ce7a",
      running: "#f2ce7a",
      succeeded: "#7ee2a8",
      failed: "#ff8a80",
      cancelled: "#9a9aa4",
    },
    marquee: "#f5f5f7",
    marqueeFill: "#ffffff14",
    snapGuide: "#f2ce7a",
    minimapFill: "#17181cd9",
    minimapViewport: "#ffffff1f",
    kindAccent: {
      text: "#9fc1e8",
      image: "#a5b4f0",
      audio: "#e8c97a",
      video: "#e8a79c",
      operation: "#b7a3e8",
      group: "#9a9aa4",
      export: "#8fd0a8",
      extension: "#c9a7f0",
    },
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  /**
   * The same drawing read on a sheet: light where graphite is dark, with the
   * accents darkened so every mark keeps its contrast against paper.
   */
  paper: {
    background: "#f4f4f1",
    grid: "#d8d8d2",
    nodeFill: "#ffffff",
    nodeStroke: "#d2d2cb",
    nodeTitle: "#1d1d22",
    nodeMuted: "#71717a",
    nodeShadow: "#00000018",
    groupFill: "#00000006",
    alertFill: "#fdeceb",
    progressTrack: "#00000014",
    selection: "#1d1d22",
    edge: "#63636d",
    edgeSelected: "#101014",
    edgeRelated: "#3c3c46",
    port: "#8b8b94",
    portCompatible: "#2f9e63",
    portRejected: "#c2554a",
    runStatus: {
      queued: "#a97b1f",
      running: "#a97b1f",
      succeeded: "#2f9e63",
      failed: "#c2554a",
      cancelled: "#71717a",
    },
    marquee: "#1d1d22",
    marqueeFill: "#1d1d2214",
    snapGuide: "#a97b1f",
    minimapFill: "#ffffffe6",
    minimapViewport: "#0000001f",
    kindAccent: {
      text: "#2f5f96",
      image: "#4a5bb5",
      audio: "#8a6a12",
      video: "#a04a3c",
      operation: "#6a4fa8",
      group: "#71717a",
      export: "#2e7d55",
      extension: "#7a4fa8",
    },
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
};

/**
 * The palette the canvas is drawn in right now.
 *
 * Drawing modules hold this object rather than one of the named palettes, so
 * switching is one assignment and the next frame is painted in the new colors
 * without any of them being told that anything happened.
 */
export const canvasTheme: CanvasPalette = { ...CANVAS_THEMES.graphite };

/** Swaps the drawing palette; the next frame is drawn in the new one. */
export function applyCanvasTheme(name: CanvasThemeName) {
  Object.assign(canvasTheme, CANVAS_THEMES[name]);
}

export const NODE_HEADER_HEIGHT = 30;
export const PORT_RADIUS = 5;
export const PORT_SPACING = 22;
