// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createStory, type MokaFile } from "../../../shared/domain";
import {
  buildEmptyStory,
  buildStoryMokaFile,
  storyIds,
} from "../../../shared/domain/fixtures";
import { useProjectStore } from "../../editor/stores/projectStore";
import {
  defaultUiPrefs,
  replaceUiPrefs,
  resetUiPrefs,
} from "../../../shared/prefs/prefsData";
import type { UiPreferences } from "../../../shared/prefs/types";
import { useStoryStore } from "./storyStore";

function store() {
  return useStoryStore.getState();
}

/** The fixture's project under a name of its own. */
function project(id: string, moka: MokaFile = buildStoryMokaFile()): MokaFile {
  return { ...moka, metadata: { ...moka.metadata, id } };
}

/** The same project with one more telling at the end of its list. */
function withStory(
  moka: MokaFile,
  name: string,
): { moka: MokaFile; id: string } {
  const added = createStory(name);
  return {
    moka: { ...moka, stories: [...(moka.stories ?? []), added] },
    id: added.id,
  };
}

function open(moka: MokaFile) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-story-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
}

beforeEach(() => {
  resetUiPrefs();
  useProjectStore.getState().close();
  store().forget();
});

describe("where the room is standing", () => {
  it("opens a project onto its first story, at the step the work has reached", () => {
    store().adopt(buildStoryMokaFile());
    // The fixture is settled through the elements, so the board is the work
    // that is wanted next.
    expect(store().storyId).toBe(storyIds().story);
    expect(store().step).toBe("storyboard");
  });

  it("stands on no story at all when the project tells none", () => {
    const moka = buildStoryMokaFile();
    store().adopt({ ...moka, stories: [] });
    expect(store().storyId).toBeNull();
    expect(store().step).toBe("idea");
  });

  it("comes back to the story and the step it was left on", () => {
    const moka = project("p1");
    open(moka);
    store().adopt(moka);
    store().goStep("outline");

    store().forget();
    store().adopt(moka);
    expect(store().storyId).toBe(storyIds().story);
    expect(store().step).toBe("outline");
  });

  it("stands beside the story that was taken away", () => {
    const { moka, id } = withStory(project("p1"), "第二个故事");
    open(moka);
    store().adopt(moka);
    store().select(id);

    const without = {
      ...moka,
      stories: moka.stories!.filter((story) => story.id !== id),
    };
    store().adopt(without);
    expect(store().storyId).toBe(storyIds().story);
  });

  it("falls back to a step the story has reached when the one remembered is out of reach", () => {
    const moka = project("p1", buildEmptyStory("新的故事"));
    open(moka);
    store().adopt(moka);
    // A story with nothing settled cannot be stood on at its last step, even
    // though that is where the reader was left.
    store().goStep("edit");

    store().forget();
    store().adopt(moka);
    expect(store().step).toBe("idea");
  });

  it("takes a place it cannot read as one that was never written", () => {
    const moka = project("p1");
    replaceUiPrefs({
      ...defaultUiPrefs(),
      storyPlaces: { p1: { storyId: 7, step: "nowhere" } },
    } as unknown as UiPreferences);
    store().adopt(moka);
    expect(store().storyId).toBe(storyIds().story);
    expect(store().step).toBe("storyboard");
  });

  it("keeps one project's place out of another's", () => {
    const { moka: first, id } = withStory(project("p1"), "第二个故事");
    const second = project("p2");
    open(first);
    store().adopt(first);
    store().select(id);

    store().forget();
    open(second);
    store().adopt(second);
    expect(store().storyId).toBe(storyIds().story);

    store().forget();
    open(first);
    store().adopt(first);
    expect(store().storyId).toBe(id);
  });

  it("puts everything it was holding down when the project is put down", () => {
    const moka = project("p1");
    open(moka);
    store().adopt(moka);
    store().toggleExpanded("element-hero");
    store().setNewStoryOpen(true);

    store().forget();
    expect(store().storyId).toBeNull();
    expect(store().step).toBe("idea");
    expect(store().openChapterId).toBeNull();
    expect(store().expanded).toEqual([]);
    expect(store().newStoryOpen).toBe(false);
  });
});

describe("what the room is showing of a story", () => {
  it("opens on the first episode until another is asked for", () => {
    const moka = project("p1");
    open(moka);
    store().adopt(moka);
    // No episode named is the first one, which is what a story opens on.
    expect(store().openChapterId).toBeNull();

    store().openChapter(storyIds().chapterSecond);
    expect(store().openChapterId).toBe(storyIds().chapterSecond);
  });

  it("unfolds and folds a card", () => {
    store().toggleExpanded("act-1");
    expect(store().expanded).toEqual(["act-1"]);
    store().toggleExpanded("act-1");
    expect(store().expanded).toEqual([]);
  });

  it("walks to a step without asking the document for anything", () => {
    const moka = project("p1");
    open(moka);
    store().adopt(moka);
    store().goStep("idea");

    // The way the top bar's "export the film" goes: the film is made on the
    // fifth step, so that is the step the reader is put on.
    store().goStep("edit");
    expect(store().step).toBe("edit");
  });
});

describe("leaving the elements step with reading still to send", () => {
  it("asks before stepping away, and goes only when told to", () => {
    const moka = project("p1");
    open(moka);
    store().adopt(moka);
    store().goStep("elements");
    store().setElementsBusy(true);

    store().goStep("outline");
    expect(store().step).toBe("elements");
    expect(store().pendingLeave).toEqual({ kind: "step", step: "outline" });

    // Staying puts the question down and leaves the reader where they were.
    store().stay();
    expect(store().step).toBe("elements");
    expect(store().pendingLeave).toBeNull();

    store().goStep("outline");
    store().leaveNow();
    expect(store().step).toBe("outline");
    expect(store().pendingLeave).toBeNull();
  });

  it("goes straight through once the reading is over", () => {
    const moka = project("p1");
    open(moka);
    store().adopt(moka);
    store().goStep("elements");
    store().setElementsBusy(true);
    store().setElementsBusy(false);

    store().goStep("outline");
    expect(store().step).toBe("outline");
    expect(store().pendingLeave).toBeNull();
  });

  it("asks before another story is opened, and opens it when told to", () => {
    const { moka, id } = withStory(project("p1"), "第二个故事");
    open(moka);
    store().adopt(moka);
    store().goStep("elements");
    store().setElementsBusy(true);

    store().select(id);
    expect(store().storyId).toBe(storyIds().story);
    expect(store().pendingLeave).toEqual({ kind: "story", storyId: id });

    store().leaveNow();
    expect(store().storyId).toBe(id);
  });

  it("does not hold a reader back on another step's work", () => {
    const moka = project("p1");
    open(moka);
    store().adopt(moka);
    // A drawing batch is the elements step's work too, but nothing it has not
    // sent yet would be lost by standing on another step.
    store().goStep("storyboard");
    store().setElementsBusy(true);
    store().goStep("idea");
    expect(store().step).toBe("idea");
  });
});
