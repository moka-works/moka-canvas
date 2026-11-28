import {
  WorkspaceSide,
  type WorkspaceFace,
} from "../../workspace/WorkspaceSide";
import { StepsIcon, StoriesIcon } from "../../workspace/icons";
import {
  useActiveStory,
  useStoryStore,
  type StorySideFace,
} from "../stores/storyStore";
import { StorySide } from "./StorySide";
import { StorySteps } from "./StorySteps";

interface RailFace extends WorkspaceFace {
  id: StorySideFace;
}

/** The stories a project tells, and the five steps of the one that is open. */
const GROUPS: readonly (readonly RailFace[])[] = [
  [
    {
      id: "stories",
      label: "story:rail.stories",
      hint: "story:rail.storiesHint",
      icon: StoriesIcon,
    },
    {
      id: "steps",
      label: "story:rail.steps",
      hint: "story:rail.stepsHint",
      icon: StepsIcon,
    },
  ],
];

/**
 * The story room's left side: the stories, and the steps of the open one.
 *
 * Both are read down the same column rather than one standing in the stage's
 * way: the list is where a telling is chosen, renamed or taken away, and the
 * steps are where the telling is walked. With the steps out of the stage, the
 * work its step draws gets the whole width of the room.
 */
export function StorySidebar() {
  const story = useActiveStory();
  const side = useStoryStore((state) => state.side);
  const setSide = useStoryStore((state) => state.setSide);
  // A room whose telling is open stands on the steps; one with nothing open
  // stands on the list, since choosing a story is the first thing there is to
  // do. A reader who turned the column themselves keeps it where they left it.
  const active: StorySideFace = side ?? (story ? "steps" : "stories");
  return (
    <WorkspaceSide
      active={active}
      columnClassName="story-side"
      groups={GROUPS}
      label="story:rail.label"
      onSelect={(id) => setSide(id as StorySideFace)}
      testIdPrefix="story-face"
    >
      {active === "stories" ? <StorySide /> : <StorySteps story={story} />}
    </WorkspaceSide>
  );
}
