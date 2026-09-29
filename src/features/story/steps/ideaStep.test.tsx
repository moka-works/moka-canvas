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

import { assetsApi } from "../../../api";
import {
  buildEmptyStory,
  buildStoryMokaFile,
} from "../../../shared/domain/fixtures";
import {
  MAX_TOTAL_DURATION_MS,
  STORY_IDEA_MAX,
  timelineSizeForAspect,
  type MokaFile,
} from "../../../shared/domain";
import { undo } from "../../editor/commands/execute";
import { useAppStore } from "../../editor/stores/appStore";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { StoryPage } from "../StoryPage";
import { useStoryJobStore } from "../stores/storyJobStore";
import { useStoryStore } from "../stores/storyStore";

/** The room, open on its first story, standing on the premise. */
function openRoom(moka: MokaFile) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-idea-test",
    selfCheck: { ok: true, issues: [] },
  });
  render(<StoryPage />);
}

/** The room as a reader reaches the premise: the page, standing on step one. */
function openAtIdea(moka: MokaFile) {
  openRoom(moka);
  fireEvent.click(screen.getByTestId("story-step-idea"));
}

function story() {
  const held = useProjectStore.getState().moka?.stories?.[0];
  if (held === undefined) throw new Error("a story is open");
  return held;
}

function ideaBox(): HTMLTextAreaElement {
  return screen.getByTestId("story-idea-input") as HTMLTextAreaElement;
}

/** Writes the premise the way a reader does: type, then look away. */
function writePremise(text: string) {
  fireEvent.change(ideaBox(), { target: { value: text } });
  fireEvent.blur(ideaBox());
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      // A manuscript read back is the text the reader uploaded.
      if (url.includes("/assets/")) {
        return Promise.resolve(new Response("夜里十一点，末班列车。"));
      }
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
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
  vi.restoreAllMocks();
});

describe("writing a premise", () => {
  it("writes it down when the reader looks away, and takes one undo to take back", () => {
    openRoom(buildEmptyStory("空故事"));

    writePremise("末班列车上，两个陌生人交换了各自要说的话。");
    expect(story().brief.idea).toBe(
      "末班列车上，两个陌生人交换了各自要说的话。",
    );

    act(() => {
      undo();
    });
    expect(story().brief.idea).toBe("");
    // The box shows what the document holds again, not what was typed.
    expect(ideaBox().value).toBe("");
  });

  it("counts the characters, and turns the count red at the ceiling", () => {
    openRoom(buildEmptyStory("空故事"));

    expect(screen.getByTestId("story-idea-count").textContent).toBe(
      `0 / ${STORY_IDEA_MAX}`,
    );

    const full = "字".repeat(STORY_IDEA_MAX);
    fireEvent.change(ideaBox(), { target: { value: full } });
    const count = screen.getByTestId("story-idea-count");
    expect(count.textContent).toBe(`${STORY_IDEA_MAX} / ${STORY_IDEA_MAX}`);
    expect(count.className).toContain("is-full");
    // The ceiling is on the input itself, so nothing longer can be typed.
    expect(ideaBox().maxLength).toBe(STORY_IDEA_MAX);
  });

  it("keeps the next step out of reach until the premise is settled", () => {
    openRoom(buildEmptyStory("空故事"));

    // Nothing written yet: the press says what is missing and stays put.
    fireEvent.click(screen.getByTestId("story-confirm-idea"));
    expect(screen.getByTestId("story-confirm-gaps-idea").textContent).toContain(
      "The premise is not written yet",
    );
    expect(useStoryStore.getState().step).toBe("idea");
    expect(story().confirmedSteps).toEqual([]);

    writePremise("末班列车上，两个陌生人交换了各自要说的话。");
    fireEvent.click(screen.getByTestId("story-confirm-idea"));
    expect(screen.queryByTestId("story-confirm-gaps-idea")).toBeNull();
    expect(story().confirmedSteps).toEqual(["idea"]);
    expect(useStoryStore.getState().step).toBe("outline");
  });

  it("writes the words down before the press reads them", () => {
    // A reader who types and presses confirm without clicking elsewhere has
    // not blurred the box; the premise still has to make it into the document.
    openRoom(buildEmptyStory("空故事"));

    fireEvent.change(ideaBox(), {
      target: { value: "末班列车上，两个陌生人交换了各自要说的话。" },
    });
    fireEvent.click(screen.getByTestId("story-confirm-idea"));

    expect(story().brief.idea).toBe(
      "末班列车上，两个陌生人交换了各自要说的话。",
    );
    expect(useStoryStore.getState().step).toBe("outline");
  });
});

describe("uploading a manuscript", () => {
  it("files it, keeps the words out of the document, and shows where they are", async () => {
    openRoom(buildEmptyStory("空故事"));
    vi.spyOn(assetsApi, "upload").mockResolvedValue({
      entry: {
        id: "asset-novel",
        name: "novel.txt",
        path: "assets/texts/novel-00000000.txt",
        mime: "text/plain",
        bytes: 40_000,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      revision: 2,
      updatedAt: "2026-01-01T00:00:00Z",
    });

    fireEvent.click(screen.getByTestId("story-idea-tab-upload"));
    const file = new File(["夜里十一点，末班列车。"], "novel.txt", {
      type: "text/plain",
    });
    fireEvent.change(screen.getByTestId("story-file"), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(story().brief.sourceAssetId).toBe("asset-novel");
    });
    expect(story().brief.sourceName).toBe("novel.txt");
    // The document points at the manuscript rather than holding it: the whole
    // premise slot is still whatever was typed, and the words stay in the file.
    expect(JSON.stringify(story().brief)).not.toContain("夜里十一点");
    expect(screen.getByTestId("story-source").textContent).toContain(
      "novel.txt",
    );
    expect(screen.getByTestId("story-source").textContent).toContain(
      "11 characters",
    );
  });

  it("takes a manuscript as a premise, so the next step is reached", async () => {
    openRoom(buildEmptyStory("空故事"));
    vi.spyOn(assetsApi, "upload").mockResolvedValue({
      entry: {
        id: "asset-novel",
        name: "novel.txt",
        path: "assets/texts/novel-00000000.txt",
        mime: "text/plain",
        bytes: 40_000,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      revision: 2,
      updatedAt: "2026-01-01T00:00:00Z",
    });

    fireEvent.click(screen.getByTestId("story-idea-tab-upload"));
    fireEvent.change(screen.getByTestId("story-file"), {
      target: { files: [new File(["稿子"], "novel.txt")] },
    });

    await waitFor(() => {
      expect(story().brief.sourceAssetId).toBe("asset-novel");
    });
    // A manuscript is a premise of its own: the press settles the step.
    fireEvent.click(screen.getByTestId("story-confirm-idea"));
    expect(story().confirmedSteps).toEqual(["idea"]);
    expect(useStoryStore.getState().step).toBe("outline");
  });

  it("files what is waiting first, and rests on the revision the filing answers with", async () => {
    openRoom(buildEmptyStory("空故事"));
    let waiting: number | null = null;
    vi.spyOn(assetsApi, "upload").mockImplementation(async () => {
      waiting = useProjectStore.getState().pending.length;
      return {
        entry: {
          id: "asset-novel",
          name: "novel.txt",
          path: "assets/texts/novel-00000000.txt",
          mime: "text/plain",
          bytes: 40_000,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        revision: 4,
        updatedAt: "2026-01-01T00:00:00Z",
      };
    });

    // A premise written a moment ago, its save still on the debounce when the
    // manuscript is handed in.
    writePremise("末班列车上的两个人。");
    fireEvent.click(screen.getByTestId("story-idea-tab-upload"));
    fireEvent.change(screen.getByTestId("story-file"), {
      target: { files: [new File(["稿子"], "novel.txt")] },
    });

    await waitFor(() => {
      expect(story().brief.sourceAssetId).toBe("asset-novel");
    });
    // What was waiting went out before the file was filed: filing a manuscript
    // moves the project on itself, so a premise saved after it would rest on a
    // revision the upload had already replaced and be refused.
    expect(waiting).toBe(0);
    expect(story().brief.idea).toBe("末班列车上的两个人。");
    // The entry joins the shelf, under the revision the filing answered with.
    const held = useProjectStore.getState().moka;
    expect(
      held?.resources.texts.some((entry) => entry.id === "asset-novel"),
    ).toBe(true);
    expect(held?.metadata.revision).toBe(4);
  });

  it("says the save is blocked, and why, rather than that it is still saving", async () => {
    openRoom(buildEmptyStory("空故事"));
    const upload = vi.spyOn(assetsApi, "upload");
    // A document another window has moved on: the premise cannot be written and
    // nothing is on its way, so the manuscript has nowhere to be filed. What a
    // reader is told is the blockage — a reader told "still saving" waits for a
    // save that is not coming.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST" && url.includes("/commands")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                code: "REVISION_CONFLICT",
                message: "canvas.moka changed on disk",
              }),
              {
                status: 409,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );

    writePremise("末班列车上的两个人。");
    await waitFor(() => {
      expect(useProjectStore.getState().saveStatus).toBe("conflicted");
    });

    fireEvent.click(screen.getByTestId("story-idea-tab-upload"));
    fireEvent.change(screen.getByTestId("story-file"), {
      target: { files: [new File(["稿子"], "novel.txt")] },
    });

    await waitFor(() => {
      const said = useAppStore.getState().toasts.at(-1);
      expect(said?.message).toBe(
        "The project changed elsewhere — reload it, or give this change up",
      );
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it("refuses the wrong kind of file, and one that is too big, with reasons", () => {
    openRoom(buildEmptyStory("空故事"));
    const upload = vi.spyOn(assetsApi, "upload");
    fireEvent.click(screen.getByTestId("story-idea-tab-upload"));

    fireEvent.change(screen.getByTestId("story-file"), {
      target: { files: [new File(["x"], "novel.pdf")] },
    });
    expect(useAppStore.getState().toasts.at(-1)?.message).toContain(".txt");
    expect(upload).not.toHaveBeenCalled();

    const huge = new File(["x"], "novel.txt");
    Object.defineProperty(huge, "size", { value: 9 * 1024 * 1024 });
    fireEvent.change(screen.getByTestId("story-file"), {
      target: { files: [huge] },
    });
    expect(useAppStore.getState().toasts.at(-1)?.message).toContain("8 MB");
    expect(upload).not.toHaveBeenCalled();
  });

  it("takes the file away without taking it off the shelf", () => {
    openAtIdea(buildStoryMokaFile());
    fireEvent.click(screen.getByTestId("story-idea-tab-upload"));
    expect(screen.getByTestId("story-source")).toBeTruthy();

    fireEvent.click(screen.getByTestId("story-source-remove"));

    expect(story().brief.sourceAssetId).toBeUndefined();
    expect(story().brief.sourceName).toBeUndefined();
    // The manuscript is still an asset of the project.
    expect(
      useProjectStore
        .getState()
        .moka?.resources.texts.some(
          (entry) => entry.id === "asset-story-source",
        ),
    ).toBe(true);
  });
});

describe("the four settings", () => {
  it("writes the running time and says what it comes to", () => {
    openAtIdea(buildStoryMokaFile());

    fireEvent.click(screen.getByTestId("story-idea-duration-3"));
    expect(story().brief.totalDurationMs).toBe(180_000);
    expect(
      screen.getByTestId("story-idea-duration-hint").textContent,
    ).toContain("3 chapters");
    expect(
      screen.getByTestId("story-idea-duration-hint").textContent,
    ).toContain("03:00");

    fireEvent.change(screen.getByTestId("story-idea-duration"), {
      target: { value: "0.5" },
    });
    expect(story().brief.totalDurationMs).toBe(30_000);
  });

  it("keeps the running time inside what a story may be", () => {
    openAtIdea(buildStoryMokaFile());

    fireEvent.change(screen.getByTestId("story-idea-duration"), {
      target: { value: "9999" },
    });
    expect(story().brief.totalDurationMs).toBe(MAX_TOTAL_DURATION_MS);

    fireEvent.change(screen.getByTestId("story-idea-duration"), {
      target: { value: "0" },
    });
    expect(story().brief.totalDurationMs).toBe(30_000);
  });

  it("writes the frame and says what it exports as", () => {
    openAtIdea(buildStoryMokaFile());

    fireEvent.click(screen.getByTestId("story-idea-aspect-9:16"));

    expect(story().brief.aspect).toBe("9:16");
    const size = timelineSizeForAspect("9:16");
    expect(screen.getByTestId("story-idea-aspect-hint").textContent).toContain(
      `${size.width}×${size.height}`,
    );
  });

  it("writes the genre and the look, from a chip or from the reader's own words", () => {
    openAtIdea(buildStoryMokaFile());

    fireEvent.click(screen.getByTestId("story-idea-genre-悬疑"));
    expect(story().brief.genre).toBe("悬疑");

    fireEvent.change(screen.getByTestId("story-idea-style-input"), {
      target: { value: "潮湿的霓虹" },
    });
    expect(story().brief.style).toBe("潮湿的霓虹");
    // A look of the reader's own is written one letter at a time, and the chip
    // that was on is off because the words are no longer its own.
    expect(screen.getByTestId("story-idea-style-input")).toBeTruthy();
  });

  it("says what each setting is for", () => {
    openRoom(buildEmptyStory("空故事"));
    const hints = [...document.querySelectorAll(".story-hint")].map(
      (hint) => hint.textContent ?? "",
    );
    expect(hints.join()).toContain("chapters");
    expect(hints.join()).toContain("The finished film is");
    expect(hints.join()).toContain("the elements and the board");
    expect(hints.join()).toContain("every picture prompt");
  });
});

describe("coming back to the premise", () => {
  it("shows what the document holds, and says a re-split is a decision", () => {
    openAtIdea(buildStoryMokaFile());
    // The fixture's story is already in chapters, so changing the premise is
    // not something the room does behind the reader's back.
    expect(screen.getByRole("status").textContent).toContain("re-split");
    expect(ideaBox().value).toBe("末班列车上，两个陌生人交换了各自要说的话。");
  });
});
