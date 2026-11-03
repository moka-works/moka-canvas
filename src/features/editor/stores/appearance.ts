import { create } from "zustand";
import { CANVAS_THEME_NAMES, type CanvasThemeName } from "../canvas/theme";
import {
  currentUiPrefs,
  rememberUiPrefs,
} from "../../../shared/prefs/prefsData";

/**
 * Which canvas palette is in use. Which colors somebody likes to work in is
 * about them rather than about the work, so it is kept in the interface
 * preferences beside the project and never inside it — a package handed to
 * somebody else carries none of it.
 */
function read(): CanvasThemeName {
  const kept = currentUiPrefs().canvasTheme;
  return CANVAS_THEME_NAMES.find((name) => name === kept) ?? "graphite";
}

export interface AppearanceState {
  theme: CanvasThemeName;
  setTheme: (theme: CanvasThemeName) => void;
}

export const useAppearance = create<AppearanceState>()((set) => ({
  theme: read(),
  setTheme: (theme) => {
    rememberUiPrefs({ canvasTheme: theme });
    set({ theme });
  },
}));
