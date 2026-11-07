import { useTranslation } from "react-i18next";
import { PageTopBar } from "../../editor/panels/PageTopBar";
import { useStoryStore } from "../stores/storyStore";
import { StoryTabs } from "./StoryTabs";

interface StoryTopBarProps {
  /** Going home from the story room, which puts the project down first. */
  onHome: () => void;
  /** Whether the room may hand over to another as it stands. */
  onGo?: (phase: "editing" | "clip" | "assets") => boolean;
}

/**
 * The story room's bar: the shared one, with the stories where the boards of
 * the canvas and the cuts of the cutting room stand.
 *
 * Which story is open is said twice on this page and both times on purpose: the
 * strip is the way across the room's width, and the column beside it is where a
 * story is renamed, taken away and read for how far it has got.
 */
export function StoryTopBar({ onHome, onGo }: StoryTopBarProps) {
  const { t } = useTranslation();
  return (
    <PageTopBar
      current="story"
      exportItems={
        <button
          data-testid="story-export-film"
          onClick={() => useStoryStore.getState().goStep("edit")}
          role="menuitem"
          type="button"
        >
          {t("story:topBar.exportFilm")}
        </button>
      }
      onGo={onGo}
      onHome={onHome}
      tabs={<StoryTabs />}
    />
  );
}
