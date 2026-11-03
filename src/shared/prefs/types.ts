/**
 * The shapes the interface preferences file carries.
 *
 * Kept apart from the client that fetches them so modules that only read the
 * snapshot (the words, above all) do not pull the HTTP layer into their graph.
 */

/** Whether each panel beside the canvas is folded away. */
export interface PanelFolds {
  left: boolean;
  right: boolean;
}

/** How wide each panel was left; `null` means never dragged. */
export interface PanelWidths {
  left: number | null;
  right: number | null;
}

/** A grid the picture-splitting tool was last asked for. */
export interface PictureGrid {
  rows: number;
  cols: number;
}

/** Which picture tools the row offers, and what those tools remember. */
export interface PictureToolsPrefs {
  /** `null` leaves the row showing every tool. */
  shown: string[] | null;
  cropRatio: string | null;
  grid: PictureGrid | null;
}

/** Where one timeline was left: its scale, its scroll, and its playhead. */
export interface TimelineViewPrefs {
  pxPerSec: number;
  scrollLeftPx: number;
  playheadMs: number;
}

/** Where the story room was left in one project. */
export interface StoryPlace {
  storyId: string | null;
  step: string | null;
}

/**
 * Choices about the interface rather than about the work.
 *
 * Kept in the metadata directory by the server, which is why a window that
 * moves to another port still opens with the language, palette, and panel
 * geometry it was left with.
 */
export interface UiPreferences {
  locale: string;
  canvasTheme: string;
  panelFolds: PanelFolds;
  panelWidths: PanelWidths;
  pictureTools: PictureToolsPrefs;
  openCanvases: Record<string, string[]>;
  clipTimelines: Record<string, string>;
  clipViews: Record<string, TimelineViewPrefs>;
  clipQuality: string;
  clipVolume: number;
  clipSnap: boolean;
  stageSplit: number;
  storyModels: Record<string, string>;
  storyPlaces: Record<string, StoryPlace>;
  directorOnboarding: string | null;
  lastUpdateCheck: number | null;
}

/**
 * What one window changed. Every field is optional; a map entry is a value to
 * write or `null` to remove, and a field left out keeps its stored value.
 */
export interface UiPrefsPatch {
  locale?: string;
  canvasTheme?: string;
  panelFolds?: PanelFolds;
  panelWidths?: PanelWidths;
  pictureTools?: PictureToolsPrefs;
  clipQuality?: string;
  clipVolume?: number;
  clipSnap?: boolean;
  stageSplit?: number;
  directorOnboarding?: string;
  lastUpdateCheck?: number;
  openCanvases?: Record<string, string[] | null>;
  clipTimelines?: Record<string, string | null>;
  clipViews?: Record<string, TimelineViewPrefs | null>;
  storyModels?: Record<string, string | null>;
  storyPlaces?: Record<string, StoryPlace | null>;
}
