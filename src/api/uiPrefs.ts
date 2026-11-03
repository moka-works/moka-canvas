import type { UiPreferences, UiPrefsPatch } from "../shared/prefs/types";
import { http } from "./client";

export type {
  PanelFolds,
  PanelWidths,
  PictureGrid,
  PictureToolsPrefs,
  StoryPlace,
  TimelineViewPrefs,
  UiPreferences,
  UiPrefsPatch,
} from "../shared/prefs/types";

export const uiPrefsApi = {
  get(signal?: AbortSignal): Promise<UiPreferences> {
    return http.request<UiPreferences>("/api/v1/ui-prefs", { signal });
  },

  patch(patch: UiPrefsPatch, keepalive = false): Promise<UiPreferences> {
    return http.request<UiPreferences>("/api/v1/ui-prefs", {
      method: "PATCH",
      body: patch,
      keepalive,
    });
  },

  reset(): Promise<UiPreferences> {
    return http.request<UiPreferences>("/api/v1/ui-prefs", {
      method: "DELETE",
    });
  },
};
