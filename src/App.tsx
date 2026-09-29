import { lazy, Suspense, useEffect } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import {
  BootErrorScreen,
  BootScreen,
  PageLoading,
} from "./features/editor/components/BootScreen";
import { Toasts } from "./features/editor/components/Toasts";
import { LauncherPage } from "./features/editor/launcher/LauncherPage";
import { SavePathHost } from "./features/editor/launcher/SavePathHost";
import { useAppStore } from "./features/editor/stores/appStore";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { useModelStore } from "./features/settings/modelStore";

// The board, the cutting room, the story room, and the room the project's
// files are read in are the heaviest rooms of the app, and none of them is
// where it starts: each arrives as a chunk of its own instead of weighing down
// the entry bundle the launcher actually needs.
const EditorPage = lazy(() =>
  import("./features/editor/EditorPage").then((module) => ({
    default: module.EditorPage,
  })),
);
const ClipPage = lazy(() =>
  import("./features/clip/ClipPage").then((module) => ({
    default: module.ClipPage,
  })),
);
const StoryPage = lazy(() =>
  import("./features/story/StoryPage").then((module) => ({
    default: module.StoryPage,
  })),
);
const AssetsPage = lazy(() =>
  import("./features/assets/AssetsPage").then((module) => ({
    default: module.AssetsPage,
  })),
);

export default function App() {
  const phase = useAppStore((state) => state.phase);

  useEffect(() => {
    void useAppStore.getState().boot();
  }, []);

  // The app draws its own context menus, so the browser/webview default one
  // must never appear on top of them (web and desktop behave the same here).
  useEffect(() => {
    const suppress = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", suppress);
    return () => document.removeEventListener("contextmenu", suppress);
  }, []);

  // Apart from boot on purpose: model configuration is something the app
  // shows, not something it needs in order to start.
  useEffect(() => {
    void useModelStore.getState().load();
  }, []);

  // A room is fetched while the launcher is up: the launcher is where a session
  // starts and where nothing is being read yet, and it leads to any of the four
  // — so a room entered from a recent row finds its chunk already here rather
  // than fetching it while the reader waits on the door.
  useEffect(() => {
    if (phase !== "launcher") return;
    void import("./features/editor/EditorPage");
    void import("./features/clip/ClipPage");
    void import("./features/assets/AssetsPage");
    void import("./features/story/StoryPage");
  }, [phase]);

  return (
    <ErrorBoundary>
      {phase === "booting" && <BootScreen />}
      {phase === "error" && <BootErrorScreen />}
      {(phase === "launcher" || phase === "opening") && <LauncherPage />}
      <Suspense fallback={<PageLoading />}>
        {phase === "editing" && <EditorPage />}
        {phase === "clip" && <ClipPage />}
        {phase === "story" && <StoryPage />}
        {phase === "assets" && <AssetsPage />}
      </Suspense>
      <SettingsDialog />
      <SavePathHost />
      <Toasts />
    </ErrorBoundary>
  );
}
