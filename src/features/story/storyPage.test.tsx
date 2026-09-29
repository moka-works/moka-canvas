// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createStory, STORY_STEPS, type MokaFile } from "../../shared/domain";
import {
  buildEmptyStory,
  buildGoldenMokaFile,
  buildStoryMokaFile,
  storyIds,
} from "../../shared/domain/fixtures";
import { undo } from "../editor/commands/execute";
import { useAppStore } from "../editor/stores/appStore";
import { useHistoryStore } from "../editor/stores/historyStore";
import { useProjectStore } from "../editor/stores/projectStore";
import { StoryPage } from "./StoryPage";
import { useStoryJobStore } from "./stores/storyJobStore";
import { useStoryStore } from "./stores/storyStore";

const fetchMock = vi.fn<typeof fetch>();

/** The room as a reader reaches it: the project open and the page standing. */
function openRoom(moka: MokaFile) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-story-test",
    selfCheck: { ok: true, issues: [] },
  });
  render(<StoryPage />);
}

/** Whatever the room is asked to do outside a press, which React has to see. */
function quietly<T>(work: () => T): T {
  let done: T;
  act(() => {
    done = work();
  });
  return done!;
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

/** The name a row stands under, by the row that is standing. */
function rowNames(): string[] {
  return [...document.querySelectorAll(".story-row-name")].map(
    (row) => row.textContent ?? "",
  );
}

function activeRow(): string | null {
  const row = document.querySelector(".story-row.is-active .story-row-name");
  return row?.textContent ?? null;
}

/** The names the strip across the bar stands under. */
function tabNames(): string[] {
  return [...document.querySelectorAll(".story-bar-tab > button")].map(
    (tab) => tab.textContent ?? "",
  );
}

function activeTab(): string | null {
  const tab = document.querySelector(".story-bar-tab.is-active > button");
  return tab?.textContent ?? null;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    // Entering the room asks what batches are out for its story; the tests
    // that care about one answer it themselves.
    const payload = String(input).includes("/story/jobs")
      ? []
      : { revision: 2, updatedAt: "2026-01-02T00:00:00.000Z" };
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  localStorage.clear();
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useStoryStore.getState().forget();
  useStoryJobStore.getState().reset();
  useAppStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a project that tells no story yet", () => {
  it("says so, and offers the one thing there is to do", () => {
    openRoom(buildGoldenMokaFile());
    expect(screen.getByTestId("story-empty")).toBeTruthy();
    expect(screen.getByTestId("story-side-empty")).toBeTruthy();
    expect(screen.getByTestId("story-empty-new")).toBeTruthy();
  });

  it("opens a story under the name it is given, and stands on its first step", () => {
    openRoom(buildGoldenMokaFile());
    fireEvent.click(screen.getByTestId("story-empty-new"));

    const dialog = screen.getByRole("dialog", { name: "New story" });
    expect(dialog).toBeTruthy();
    const name = screen.getByTestId("story-name") as HTMLInputElement;
    expect(name.value.length).toBeGreaterThan(0);
    fireEvent.change(name, { target: { value: "雨夜列车" } });
    fireEvent.click(screen.getByTestId("story-create"));

    expect(screen.queryByRole("dialog", { name: "New story" })).toBeNull();
    expect(screen.queryByTestId("story-empty")).toBeNull();
    expect(
      screen.getByTestId("story-step-idea").getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByTestId("story-step-body-idea")).toBeTruthy();
    expect(rowNames()).toEqual(["雨夜列车"]);
    expect(useProjectStore.getState().moka?.stories?.length).toBe(1);
    // The question is asked once: the name is the only thing a new story is
    // asked for, and the premise is set in the step that is standing.
    expect(useStoryStore.getState().storyId).not.toBeNull();
  });
});

describe("the five steps", () => {
  it("shows all five, with the ones not yet earned saying what comes first", () => {
    openRoom(buildEmptyStory("空故事"));
    for (const step of STORY_STEPS) {
      expect(screen.getByTestId(`story-step-${step}`)).toBeTruthy();
    }
    // A story with only a name has earned nothing past the premise, so every
    // later step waits on the one before it.
    const outline = screen.getByTestId(
      "story-step-outline",
    ) as HTMLButtonElement;
    expect(outline.disabled).toBe(true);
    expect(outline.title).toBe("Premise comes first");
    for (const step of ["elements", "storyboard", "edit"]) {
      expect(
        (screen.getByTestId(`story-step-${step}`) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    }
    expect(screen.getByTestId("story-step-body-idea")).toBeTruthy();
    expect(screen.queryByTestId("story-step-body-outline")).toBeNull();
  });

  it("marks the step whose pieces did not come back", async () => {
    // A batch the room is watching: it is out when the room opens, and the
    // look that comes back says it ended with a piece short. What the step
    // shows is a count of the pieces that failed, which the document cannot
    // know — and the count is the room's own news, not a number read off
    // every record the server has kept.
    const out = {
      id: "job-1",
      projectId: "project-1",
      storyId: storyIds().story,
      kind: "storyboard",
      status: "running",
      model: "a-writer",
      items: [
        {
          id: `storyboard:${storyIds().chapterFirst}`,
          target: {
            kind: "storyboard",
            chapterId: storyIds().chapterFirst,
          },
          capability: "text",
          prompt: "board this",
          inputs: [],
          params: {},
          status: "running",
        },
      ],
      cancelRequested: false,
      createdAt: "2026-01-02T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };
    const short = {
      ...out,
      status: "failed",
      items: [
        { ...out.items[0], status: "failed", error: "the provider refused" },
      ],
    };
    let looks = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      let payload: unknown = {
        root: "/tmp/moka-story-test",
        moka: useProjectStore.getState().moka,
        selfCheck: { ok: true, issues: [] },
      };
      if (url.endsWith("/read")) {
        payload = { ...short, readAt: "2026-01-02T00:00:00Z" };
      } else if (url.includes("/story/jobs")) {
        payload = looks++ === 0 ? [out] : [short];
      }
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    // A story settled only through the outline: the board is still behind the
    // elements, and a step that cannot be walked to says that first.
    const moka = buildStoryMokaFile();
    moka.stories![0].confirmedSteps = ["idea", "outline"];
    vi.useFakeTimers();
    try {
      openRoom(moka);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });

      const badge = screen.getByTestId("story-step-failed-storyboard");
      expect(badge.textContent).toBe("1");
      const button = screen.getByTestId("story-step-storyboard");
      expect(button.className).toContain("is-failed");
      expect(button.getAttribute("title")).toBe("Elements comes first");
      // The step with nothing wrong with it carries no mark.
      expect(screen.queryByTestId("story-step-failed-outline")).toBeNull();
    } finally {
      act(() => {
        useStoryJobStore.getState().reset();
      });
      vi.useRealTimers();
    }
  });

  it("says on the step's bubble why its pieces did not come back", async () => {
    // The bubble over the badge is the only place a step says why it is red,
    // and a reader who has to open the batch to find out will not.
    const out = {
      id: "job-1",
      projectId: "project-1",
      storyId: storyIds().story,
      kind: "outline",
      status: "running",
      model: "a-writer",
      items: [
        {
          id: "outline",
          target: { kind: "outline" },
          capability: "text",
          prompt: "tell this",
          inputs: [],
          params: {},
          status: "running",
        },
      ],
      cancelRequested: false,
      createdAt: "2026-01-02T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };
    const short = {
      ...out,
      status: "failed",
      items: [
        {
          ...out.items[0],
          status: "failed",
          error: "model gpt-4o-mini has no stored API key",
          errorCode: "PROVIDER_KEY_MISSING",
          errorDetails: { model: "gpt-4o-mini" },
        },
      ],
    };
    let looks = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      let payload: unknown = {
        root: "/tmp/moka-story-test",
        moka: useProjectStore.getState().moka,
        selfCheck: { ok: true, issues: [] },
      };
      if (url.endsWith("/read")) {
        payload = { ...short, readAt: "2026-01-02T00:00:00Z" };
      } else if (url.includes("/story/jobs")) {
        payload = looks++ === 0 ? [out] : [short];
      }
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    vi.useFakeTimers();
    try {
      openRoom(buildStoryMokaFile());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });

      const badge = screen.getByTestId("story-step-failed-outline");
      expect(badge.textContent).toBe("1");
      // The step it happened on has been earned, so the bubble says the
      // reason rather than what comes first.
      expect(
        screen.getByTestId("story-step-outline").getAttribute("title"),
      ).toBe(
        "1 pieces did not come back: model gpt-4o-mini has no stored API key",
      );
    } finally {
      act(() => {
        useStoryJobStore.getState().reset();
      });
      vi.useRealTimers();
    }
  });

  it("does not mark a step for a failure that came home before the room was looking", async () => {
    // The record of a batch that failed days ago is on the list the room
    // opens over. The count over the step is the room's own now, so what
    // happened while nobody was watching is not a number that stands there —
    // and is not brought back by opening the project again.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes("/story/jobs")
        ? [
            {
              id: "job-1",
              projectId: "project-1",
              storyId: storyIds().story,
              kind: "storyboard",
              status: "failed",
              model: "a-writer",
              items: [
                {
                  id: `storyboard:${storyIds().chapterFirst}`,
                  target: {
                    kind: "storyboard",
                    chapterId: storyIds().chapterFirst,
                  },
                  capability: "text",
                  prompt: "board this",
                  inputs: [],
                  params: {},
                  status: "failed",
                  error: "the provider refused",
                },
              ],
              cancelRequested: false,
              readAt: "2026-01-02T00:00:00Z",
              createdAt: "2026-01-02T00:00:00Z",
              updatedAt: "2026-01-02T00:00:00Z",
            },
          ]
        : {
            root: "/tmp/moka-story-test",
            moka: useProjectStore.getState().moka,
            selfCheck: { ok: true, issues: [] },
          };
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    openRoom(buildStoryMokaFile());
    // The room has read the list — the record is held, not dropped.
    await waitFor(() =>
      expect(useStoryJobStore.getState().jobs).toHaveLength(1),
    );
    expect(screen.queryByTestId("story-step-failed-storyboard")).toBeNull();
    expect(screen.getByTestId("story-step-storyboard").className).not.toContain(
      "is-failed",
    );
  });

  it("walks to a step that has been earned, and stops at the ones that have not", () => {
    openRoom(buildStoryMokaFile());
    fireEvent.click(screen.getByTestId("story-step-idea"));
    const outline = screen.getByTestId(
      "story-step-outline",
    ) as HTMLButtonElement;
    expect(outline.disabled).toBe(false);
    fireEvent.click(outline);
    expect(useStoryStore.getState().step).toBe("outline");
    expect(screen.getByTestId("story-step-body-outline")).toBeTruthy();

    // The board is earned — the fixture is settled through the elements — and
    // the last step is not: nothing settles the board yet.
    expect(
      (screen.getByTestId("story-step-storyboard") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    const edit = screen.getByTestId("story-step-edit") as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(edit.title).toBe("Storyboard comes first");
  });
});

describe("the strip across the bar", () => {
  it("shows the stories being told, and turns to the one that is clicked", () => {
    const { moka, id } = withStory(buildStoryMokaFile(), "第二个故事");
    openRoom(moka);
    expect(tabNames()).toEqual(["雨夜列车", "第二个故事"]);
    expect(activeTab()).toBe("雨夜列车");

    fireEvent.click(screen.getByTestId("story-tab-第二个故事"));
    expect(activeTab()).toBe("第二个故事");
    expect(activeRow()).toBe("第二个故事");
    expect(useStoryStore.getState().storyId).toBe(id);
  });

  it("asks for a new story from the strip once there is a story to stand beside", () => {
    openRoom(buildGoldenMokaFile());
    // Nothing to put a strip across until a story exists; the empty page owns
    // the one thing there is to do.
    expect(screen.queryByTestId("story-tab-add")).toBeNull();

    fireEvent.click(screen.getByTestId("story-empty-new"));
    fireEvent.change(screen.getByTestId("story-name"), {
      target: { value: "雨夜列车" },
    });
    fireEvent.click(screen.getByTestId("story-create"));

    fireEvent.click(screen.getByTestId("story-tab-add"));
    expect(screen.getByRole("dialog", { name: "New story" })).toBeTruthy();
  });
});

describe("naming a story", () => {
  it("renames it in the column, and gives the old name back on undo", () => {
    openRoom(buildStoryMokaFile());
    fireEvent.click(screen.getByRole("button", { name: "Rename 雨夜列车" }));

    const input = screen.getByRole("textbox", { name: "Rename 雨夜列车" });
    fireEvent.change(input, { target: { value: "白昼列车" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(rowNames()).toEqual(["白昼列车"]);

    expect(quietly(() => undo())).toBe(true);
    expect(rowNames()).toEqual(["雨夜列车"]);
  });

  it("keeps the input standing when the name cannot be taken", () => {
    openRoom(buildStoryMokaFile());
    fireEvent.click(screen.getByRole("button", { name: "Rename 雨夜列车" }));

    const input = screen.getByRole("textbox", { name: "Rename 雨夜列车" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe("A story needs a name");
    expect(
      screen.getByRole("textbox", { name: "Rename 雨夜列车" }),
    ).toBeTruthy();
    expect(useProjectStore.getState().moka?.stories?.[0].name).toBe("雨夜列车");
  });
});

describe("taking a story away", () => {
  it("asks first, says what it costs, and stands beside the one that is left", () => {
    const { moka, id } = withStory(buildStoryMokaFile(), "第二个故事");
    openRoom(moka);
    quietly(() => useStoryStore.getState().select(id));
    expect(activeRow()).toBe("第二个故事");

    fireEvent.click(screen.getByTestId("story-delete-第二个故事"));
    const dialog = screen.getByTestId("remove-story");
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    // Nothing is deleted: the drawings and the timeline stay where they are,
    // and the dialog says so before the reader answers.
    expect(dialog.textContent).toContain("will no longer be referred to");

    fireEvent.click(screen.getByTestId("remove-story-confirm"));
    expect(screen.queryByTestId("remove-story")).toBeNull();
    expect(rowNames()).toEqual(["雨夜列车"]);
    expect(activeRow()).toBe("雨夜列车");
    expect(useProjectStore.getState().moka?.stories?.length).toBe(1);
  });

  it("leaves the story, and everything it holds, where it was when undone", () => {
    const { moka, id } = withStory(buildStoryMokaFile(), "第二个故事");
    openRoom(moka);
    quietly(() => useStoryStore.getState().select(id));
    fireEvent.click(screen.getByTestId("story-delete-第二个故事"));
    fireEvent.click(screen.getByTestId("remove-story-confirm"));

    expect(quietly(() => undo())).toBe(true);
    expect(rowNames()).toEqual(["雨夜列车", "第二个故事"]);
    const back = useProjectStore
      .getState()
      .moka?.stories?.find((story) => story.id === id);
    expect(back?.chapters.length).toBe(0);
    // The telling that stayed is untouched, bindings and all.
    const kept = useProjectStore
      .getState()
      .moka?.stories?.find((story) => story.id === storyIds().story);
    expect(kept?.chapters[0].acts.length).toBe(1);
    expect(kept?.edit.timelineId).toBeTruthy();
  });

  it("puts the question down without deleting when it is cancelled", () => {
    openRoom(buildStoryMokaFile());
    fireEvent.click(screen.getByTestId("story-delete-雨夜列车"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("remove-story")).toBeNull();
    expect(useProjectStore.getState().moka?.stories?.length).toBe(1);
  });
});
