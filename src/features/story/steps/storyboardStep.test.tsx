// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  buildStoryMokaFile,
  goldenNodeIds,
} from "../../../shared/domain/fixtures";
import { assetsApi } from "../../../api/assets";
import { generateApi } from "../../../api/generate";
import type { GenerateResponse } from "../../../api/generate";
import { clampSeconds } from "../jobs/plan";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useModelStore } from "../../settings/modelStore";
import { useStoryJobStore } from "../stores/storyJobStore";
import { useStoryStore } from "../stores/storyStore";
import {
  ids,
  T0,
  starts,
  held,
  answers,
  landed,
  comesBack,
  boarded,
  settle,
  withEveryFrame,
  withUndrawnFrames,
  withoutThePlace,
  withThreeUndrawnShots,
  withASecondAct,
  withTwoMissingClips,
  withAMissingClipAndAnUndrawnAct,
  withoutTheClip,
  withFilmedShot,
  openAtBoard,
  typeAtEnd,
  story,
  acts,
  card,
  boardAnswer,
  filmingAt,
  paintingWithTwoModels,
  filmingWithCeiling,
  replaceHeld,
  replaceLanded,
  confirmDraw,
  confirmFilm,
  resetStoryboard,
  cleanupStoryboard,
} from "./storyboardStepKit";

beforeEach(resetStoryboard);
afterEach(cleanupStoryboard);

describe("writing an episode's board", () => {
  it("stands a picker for every kind of work the step asks", () => {
    openAtBoard(boarded());
    // Words, pictures, clips, voices and the score are all asked for from
    // step four, so a reader sets each of them here rather than in settings.
    for (const place of ["text", "image", "video", "audio", "music"]) {
      expect(screen.getByTestId(`story-model-${place}`)).toBeDefined();
    }
    // The pictures this step draws are asked in batches like the cast's, at a
    // count the reader sets on this step's own band.
    expect(screen.getByTestId("story-model-parallel")).toBeDefined();
  });

  it("runs the board's asks at the count its band is set to", async () => {
    openAtBoard(withUndrawnFrames());
    fireEvent.change(screen.getByTestId("story-parallel"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByTestId("story-act-draw-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.kind).toBe("keyframeArt");
    expect(starts[0]!.parallel).toBe(2);
    await comesBack();
    await waitFor(() =>
      expect(
        acts()[0]?.keyframes.every((keyframe) => keyframe.art.takes.length > 0),
      ).toBe(true),
    );
  });

  it("says on the act's clock what kind of work is out, and on which model", async () => {
    openAtBoard(withUndrawnFrames());
    fireEvent.click(screen.getByTestId("story-act-draw-0"));
    await waitFor(() => expect(starts).toHaveLength(1));

    // The bar over the act names the work and the model serving it, beside
    // the clock it keeps: a shot's picture is being drawn by the painter the
    // batch was asked of, and the bar says so rather than only "generating".
    const bar = await screen.findByTestId("story-act-running");
    expect(bar.textContent).toContain("Generating pictures");
    expect(bar.textContent).toContain("a-storyteller");

    await comesBack();
    await waitFor(() =>
      expect(screen.queryByTestId("story-act-running")).toBeNull(),
    );
  });

  it("spreads a place's asks over the models picked for it, in order", async () => {
    paintingWithTwoModels();
    openAtBoard(withUndrawnFrames());

    // Two picture models are ticked into the place's list, so the two frames
    // missing a picture are not piled onto one model.
    fireEvent.click(screen.getByTestId("story-model-image-toggle"));
    fireEvent.click(screen.getByTestId("story-model-image-option-paint-1"));
    fireEvent.click(screen.getByTestId("story-model-image-option-paint-2"));
    expect(screen.getByTestId("story-model-image-count").textContent).toBe(
      "2 in rotation",
    );

    fireEvent.click(screen.getByTestId("story-act-draw-0"));
    await waitFor(() => expect(starts).toHaveLength(2));
    expect(starts.map((batch) => batch.model)).toEqual(["paint-1", "paint-2"]);

    // The act's head names the models the work really went to, rather than
    // the list it was drawn from.
    const asking = await screen.findByTestId("story-act-asking-0");
    expect(asking.textContent).toContain("Paint One");
    expect(asking.textContent).toContain("Paint Two");

    await comesBack(1);
    await comesBack(2);
    await waitFor(() =>
      expect(screen.queryByTestId("story-act-asking-0")).toBeNull(),
    );
  });

  it("rewrites a frame's words once before drawing its set, and keeps the turns", async () => {
    paintingWithTwoModels();
    useModelStore.setState({
      protocols: {
        image: {
          openaiImage: {
            script: "image/openaiImage/openaiImage.lua",
            displayName: "OpenAI Image",
            urlExample: "https://provider.test/images",
            promptRewrite: {
              guide: "IMAGE CONTRACT",
              checks: {},
              version: 1,
            },
          },
        },
      },
    });
    openAtBoard(withUndrawnFrames());

    fireEvent.click(screen.getByTestId("story-model-image-toggle"));
    fireEvent.click(screen.getByTestId("story-model-image-option-paint-1"));
    fireEvent.click(screen.getByTestId("story-model-image-option-paint-2"));
    const text = vi.spyOn(generateApi, "text").mockResolvedValue({
      status: "succeeded",
      outputs: [],
      text: "A rewritten frame.",
    } as GenerateResponse);

    fireEvent.change(screen.getByTestId("story-board-draw-missing-count"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByTestId("story-board-draw-missing-rewrite"));
    fireEvent.click(screen.getByTestId("story-board-draw-missing"));
    await waitFor(() => expect(starts).toHaveLength(2));

    // Two frames, two pictures each: the words are rewritten once per frame
    // rather than once per request, and every copy carries that one answer.
    expect(text).toHaveBeenCalledTimes(2);
    expect(
      starts.flatMap((batch) => batch.items.map((item) => item.prompt)),
    ).toEqual(Array(4).fill("A rewritten frame."));

    // The copies of a frame still take different models in turn: rewriting the
    // words changed what each ask says, not whose turn it is.
    expect(new Set(starts.map((batch) => batch.model))).toEqual(
      new Set(["paint-1", "paint-2"]),
    );
    const frames = new Set(
      starts.flatMap((batch) =>
        batch.items.map((item) => item.id.replace(/:\d+$/, "")),
      ),
    );
    expect(frames.size).toBe(2);
    for (const frame of frames) {
      const first = starts.findIndex((batch) =>
        batch.items.some((item) => item.id === `${frame}:1`),
      );
      const second = starts.findIndex((batch) =>
        batch.items.some((item) => item.id === `${frame}:2`),
      );
      expect(first).not.toBe(second);
    }
  });

  it("offers to film every complete act still short of a clip", () => {
    openAtBoard(withAMissingClipAndAnUndrawnAct());
    // The act beside it is still waiting on a drawing, so it is not a clip
    // the press would film: the count is the work its pictures stand behind.
    expect(screen.getByTestId("story-board-film-missing").textContent).toBe(
      "Film every missing clip (1)",
    );
  });

  it("counts every act short of a clip, and asks only those", async () => {
    openAtBoard(withTwoMissingClips());
    expect(screen.getByTestId("story-board-film-missing").textContent).toBe(
      "Film every missing clip (2)",
    );

    fireEvent.click(screen.getByTestId("story-board-film-missing"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.kind).toBe("actVideo");
    expect(starts[0]!.items).toHaveLength(2);
    expect(
      new Set(
        starts[0]!.items.map((item) =>
          item.target.kind === "actVideo" ? item.target.actId : "",
        ),
      ).size,
    ).toBe(2);
  });

  it("films a keyframe act's missing shots, not its whole clip", async () => {
    openAtBoard(withFilmedShot());
    expect(screen.getByTestId("story-board-film-missing").textContent).toBe(
      "Film every missing clip (1)",
    );

    fireEvent.click(screen.getByTestId("story-board-film-missing"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.kind).toBe("keyframeVideo");
    const target = starts[0]!.items[0]?.target;
    expect(target?.kind === "keyframeVideo" ? target.keyframeId : "").toBe(
      ids.frameSecond,
    );
  });

  it("films a set of takes and offers the choice on the act", async () => {
    openAtBoard(withoutTheClip());
    fireEvent.change(screen.getByTestId("story-board-film-missing-count"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByTestId("story-board-film-missing"));

    await waitFor(() => expect(starts).toHaveLength(2));
    // Two takes are two asks of the same place, read back under the same
    // names: the answers append as takes rather than as pieces of one clip.
    expect(starts.map((batch) => batch.kind)).toEqual(["actVideo", "actVideo"]);
    expect(starts[0]!.items[0]?.id).toBe(starts[1]!.items[0]?.id);

    await waitFor(() => expect(acts()[0]?.video.takes).toHaveLength(2));
    const choice = screen.getByTestId("story-act-video-0");
    expect(choice.getAttribute("aria-label")).toBe("Choose main clip (2)");
    expect(screen.queryByTestId("story-act-main-clip-0")).toBeNull();

    const takes = acts()[0]!.video.takes.map((take) => take.assetIds[0]);
    fireEvent.click(choice);
    fireEvent.click(screen.getByTestId(`story-clip-keep-${takes[0]}`));
    await waitFor(() =>
      expect(acts()[0]?.video.takes.at(-1)?.assetIds[0]).toBe(takes[0]),
    );
    expect(screen.queryByTestId("story-act-main-clip-0")).toBeNull();
    expect(choice.getAttribute("aria-label")).toBe("Play this clip");
  });

  it("rewrites each take from the board's own words, one take at a time", async () => {
    filmingWithCeiling(15);
    useModelStore.setState({
      protocols: {
        video: {
          bailianVideo: {
            script: "video/bailianVideo/bailianVideo.lua",
            displayName: "Bailian Video",
            urlExample: "https://provider.test/video-synthesis",
            promptRewrite: {
              guide: "VIDEO CONTRACT",
              checks: {},
              version: 1,
            },
          },
        },
      },
    });
    openAtBoard(withoutTheClip());
    const text = vi
      .spyOn(generateApi, "text")
      .mockResolvedValueOnce({
        status: "succeeded",
        outputs: [],
        text: "First take words.",
      } as GenerateResponse)
      .mockResolvedValueOnce({
        status: "succeeded",
        outputs: [],
        text: "Second take words.",
      } as GenerateResponse);

    fireEvent.change(screen.getByTestId("story-board-film-missing-count"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByTestId("story-board-film-missing-rewrite"));
    fireEvent.click(screen.getByTestId("story-board-film-missing"));

    await waitFor(() => expect(starts).toHaveLength(2));
    // Each take was read afresh: the second ask carries the second reading
    // of the board's words, not the first take's answer.
    expect(text).toHaveBeenCalledTimes(2);
    expect(starts[0]!.items[0]?.prompt).toBe("First take words.");
    expect(starts[1]!.items[0]?.prompt).toBe("Second take words.");
  });

  it("folds the episode strip down to the episodes around the one open", () => {
    const moka = boarded();
    openAtBoard(moka);
    fireEvent.click(screen.getByTestId("story-board-strip-fold"));

    // A telling this short hides nothing, so every chip stays — and stepping
    // to the episode beside it needs no unfolding.
    expect(screen.queryByTestId("story-board-strip-current")).toBeNull();
    expect(screen.getByTestId("story-board-chapter-0")).toBeDefined();
    expect(screen.getByTestId("story-board-chapter-1")).toBeDefined();
    fireEvent.click(screen.getByTestId("story-board-chapter-1"));
    expect(
      screen.getByTestId("story-board-chapter-1").getAttribute("aria-selected"),
    ).toBe("true");

    // The app is closed and the project opened again: the strip is found as
    // it was left rather than standing open.
    cleanup();
    openAtBoard(moka, 1);
    expect(screen.queryByTestId("story-board-strip-current")).toBeNull();

    fireEvent.click(screen.getByTestId("story-board-strip-fold"));
    expect(screen.getByTestId("story-board-chapter-0")).toBeDefined();
  });

  it("asks for the board as a table of chapters, and writes it into the story", async () => {
    openAtBoard(boarded(), 1);
    answers[`storyboard:${story().chapters[1]!.id}`] = boardAnswer(
      "close",
      "medium",
    );

    // With no board yet the header's ask writes one straight away, and says so.
    expect(screen.getByTestId("story-board-generate").textContent).toBe(
      "Write the board",
    );
    fireEvent.click(screen.getByTestId("story-board-generate"));
    await waitFor(() => expect(starts).toHaveLength(1));
    const [item] = starts[0]!.items;
    expect(starts[0]!.kind).toBe("storyboard");
    expect(item?.capability).toBe("text");
    expect(item?.prompt).toContain("林");
    expect(item?.prompt).toContain("末班车车厢");

    await comesBack();
    await waitFor(() =>
      expect(screen.getByTestId("story-act-0")).toBeDefined(),
    );
    expect(within(card(0)).getByTestId("story-table")).toBeDefined();
    expect(acts()).toHaveLength(1);
    expect(acts()[0]?.keyframes).toHaveLength(2);
  });

  it("names the picture model of one frame, and asks that frame of it", async () => {
    paintingWithTwoModels();
    openAtBoard(withUndrawnFrames());

    const picker = screen.getByTestId(
      "story-kf-image-model-0",
    ) as HTMLSelectElement;
    expect(picker.value).toBe("");
    fireEvent.change(picker, { target: { value: "paint-2" } });
    expect(acts()[0]?.keyframes[0]?.imageModel).toBe("paint-2");

    fireEvent.click(screen.getByTestId("story-act-draw-0"));
    await waitFor(() => expect(starts).toHaveLength(2));
    // Both asks are out before the test leaves: a start still settling is a
    // batch of the last test landing in the next one.
    await waitFor(() =>
      expect(useStoryJobStore.getState().starting).toBe(false),
    );
    expect(starts.map((batch) => batch.model)).toEqual(["paint-2", null]);
    expect(starts[0]?.items.map((item) => item.id)).toEqual([
      "keyframe:chapter-first:act-1:frame-1",
    ]);
    expect(starts[1]?.items.map((item) => item.id)).toEqual([
      "keyframe:chapter-first:act-1:frame-2",
    ]);
    await comesBack(1);
    await comesBack(2);
    await waitFor(() =>
      expect(
        acts()[0]?.keyframes.every((keyframe) => keyframe.art.takes.length > 0),
      ).toBe(true),
    );

    // Clearing the choice hands the frame back to the step's own model.
    fireEvent.change(
      screen.getByTestId("story-kf-image-model-0") as HTMLSelectElement,
      { target: { value: "" } },
    );
    expect(acts()[0]?.keyframes[0]?.imageModel).toBeUndefined();
  });

  it("folds a whole act down to its head, and unfolds it again", () => {
    openAtBoard(boarded());
    expect(screen.getByTestId("story-table")).toBeDefined();

    fireEvent.click(screen.getByTestId("story-act-fold-0"));
    // The act keeps its head — where it stands, what it is called, and its
    // tools — and gives up the table and everything under it.
    expect(screen.getByTestId("story-act-0")).toBeDefined();
    expect(screen.getByTestId("story-act-title-0")).toBeDefined();
    expect(screen.queryByTestId("story-table")).toBeNull();
    expect(screen.queryByTestId("story-kf-size-0")).toBeNull();
    expect(screen.queryByTestId("story-kf-slot-0")).toBeNull();

    fireEvent.click(screen.getByTestId("story-act-fold-0"));
    expect(screen.getByTestId("story-table")).toBeDefined();
    expect(screen.getByTestId("story-kf-size-0")).toBeDefined();
    expect(screen.getByTestId("story-kf-slot-0")).toBeDefined();
  });

  it("keeps an act folded when the reader steps away and comes back", () => {
    const moka = boarded();
    openAtBoard(moka);
    fireEvent.click(screen.getByTestId("story-act-fold-0"));
    expect(screen.queryByTestId("story-table")).toBeNull();

    // Another step and back: the board is found as it was left rather than
    // every act standing open again.
    act(() => useStoryStore.getState().goStep("elements"));
    act(() => useStoryStore.getState().goStep("storyboard"));
    expect(screen.getByTestId("story-act-0")).toBeDefined();
    expect(screen.queryByTestId("story-table")).toBeNull();

    // Nor does looking at the episode beside it bring the act back open.
    fireEvent.click(screen.getByTestId("story-board-chapter-1"));
    fireEvent.click(screen.getByTestId("story-board-chapter-0"));
    expect(screen.queryByTestId("story-table")).toBeNull();

    // Closing the app and opening the project again finds the act folded.
    cleanup();
    openAtBoard(moka);
    expect(screen.queryByTestId("story-table")).toBeNull();

    fireEvent.click(screen.getByTestId("story-act-fold-0"));
    expect(screen.getByTestId("story-table")).toBeDefined();
  });

  it("keeps an undrawn frame to its drawing button and More", () => {
    openAtBoard(withUndrawnFrames());
    const slot = screen.getByTestId("story-kf-slot-0");

    // The empty place holds the one button that draws it and the row's menu:
    // the sources and the choice to need no picture wait behind More rather
    // than standing on the picture.
    expect(within(slot).getByTestId("story-kf-slot-0-generate")).toBeDefined();
    const more = within(slot).getByTestId("story-kf-more-0");
    expect(more).toBeDefined();
    expect(within(slot).queryByTestId("story-kf-slot-0-library")).toBeNull();

    fireEvent.click(within(more).getByText("More"));
    expect(screen.getByTestId("story-kf-slot-0-library")).toBeDefined();
    expect(screen.getByTestId("story-kf-slot-0-upload")).toBeDefined();
    expect(screen.getByTestId("story-kf-slot-0-not-needed")).toBeDefined();
    // The words are confirmed by the drawing itself, not by a separate door.
    expect(screen.queryByTestId("story-kf-image-prompt-0")).toBeNull();
    fireEvent.click(within(slot).getByTestId("story-kf-slot-0-generate"));
    expect(screen.getByTestId("story-image-prompt-dialog")).toBeDefined();
  });

  it("keeps a drawn frame short: the shoot role among the tools, the rest behind More", () => {
    openAtBoard(boarded());
    const row = screen.getByTestId("story-kf-0");

    // The picture's cell no longer carries the shoot role; the row's tools do.
    expect(
      within(screen.getByTestId("story-kf-slot-0")).queryByTestId(
        "story-kf-role-0",
      ),
    ).toBeNull();
    const role = screen.getByTestId("story-kf-role-0");
    const cells = row.querySelectorAll("td");
    expect(cells[cells.length - 1]?.contains(role)).toBe(true);

    // Replacing, keeping from this computer, and editing the shot stand behind
    // More; the picture's words are confirmed when it is drawn again.
    const more = screen.getByTestId("story-kf-more-0");
    expect(more).toBeDefined();
    expect(screen.queryByTestId("story-kf-image-prompt-0")).toBeNull();
    fireEvent.click(within(more).getByText("More"));
    fireEvent.click(screen.getByTestId("story-kf-slot-0-library"));
    expect(screen.getByTestId("story-library")).toBeDefined();
    fireEvent.click(
      within(screen.getByTestId("story-library")).getByRole("button", {
        name: "Close",
      }),
    );
    fireEvent.click(within(more).getByText("More"));
    fireEvent.click(screen.getByTestId("story-kf-edit-0"));
    expect(screen.getByTestId("story-edit-dialog")).toBeDefined();
  });

  it("marks a hand-written prompt on the board rather than on a button", () => {
    const moka = withUndrawnFrames();
    const held = moka.stories![0]!;
    held.shotGranularity = "keyframe";
    held.imagePromptOverrides = {
      [`keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`]: {
        prompt: "A still frame of the lantern.",
        auto: "0badcafe",
      },
    };
    held.videoPromptOverrides = {
      [`keyframeVideo:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`]: {
        prompt: "Hold on the lantern.",
        auto: "0badcafe",
      },
    };
    openAtBoard(moka);

    expect(
      screen.getByTestId("story-kf-image-prompt-edited-0").textContent,
    ).toBe("Prompt edited");
    expect(
      screen.getByTestId("story-kf-video-prompt-edited-0").textContent,
    ).toBe("Prompt edited");
    // The words are not a door of their own any more: they are confirmed by
    // the drawing or filming they belong to.
    expect(screen.queryByTestId("story-kf-image-prompt-0")).toBeNull();
    expect(screen.queryByTestId("story-kf-video-prompt-0")).toBeNull();
  });

  it("keeps a picture from the shelf that the frame has never held", () => {
    openAtBoard(withUndrawnFrames());

    // The shelf holds a picture this shot has never carried, and choosing it
    // binds the file to the frame rather than only knowing the file exists.
    fireEvent.click(
      within(screen.getByTestId("story-kf-more-0")).getByText("More"),
    );
    fireEvent.click(screen.getByTestId("story-kf-slot-0-library"));
    fireEvent.click(screen.getByTestId(`story-library-${ids.heroMain}`));

    expect(acts()[0]?.keyframes[0]?.art.takes.at(-1)?.assetIds).toEqual([
      ids.heroMain,
    ]);
    expect(
      screen.getByTestId("story-kf-slot-0").querySelector("img"),
    ).not.toBeNull();
  });

  it("keeps a picture filed from this computer on the frame that asked for it", async () => {
    vi.spyOn(assetsApi, "upload").mockResolvedValue({
      entry: {
        id: "asset-frame-picture",
        name: "frame.png",
        path: "assets/images/frame-00000000.png",
        mime: "image/png",
        bytes: 68,
        createdAt: T0,
        updatedAt: T0,
      },
      revision: 2,
      updatedAt: T0,
    });
    openAtBoard(withUndrawnFrames());

    fireEvent.click(
      within(screen.getByTestId("story-kf-more-0")).getByText("More"),
    );
    fireEvent.change(screen.getByTestId("story-kf-slot-0-upload-input"), {
      target: {
        files: [new File(["x"], "frame.png", { type: "image/png" })],
      },
    });

    // The file is on the shelf first, and only then is it the frame's own.
    await waitFor(() =>
      expect(acts()[0]?.keyframes[0]?.art.takes.at(-1)?.assetIds).toEqual([
        "asset-frame-picture",
      ]),
    );
    expect(
      screen.getByTestId("story-kf-slot-0").querySelector("img"),
    ).not.toBeNull();
  });

  it("leaves the frame's More menu by clicking elsewhere or stepping back", async () => {
    openAtBoard(boarded());
    const menu = screen.getByTestId("story-kf-more-0") as HTMLDetailsElement;

    fireEvent.click(within(menu).getByText("More"));
    await waitFor(() => expect(menu.open).toBe(true));

    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(menu.open).toBe(false));

    fireEvent.click(within(menu).getByText("More"));
    await waitFor(() => expect(menu.open).toBe(true));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(menu.open).toBe(false));
  });

  it("marks a frame whose reference was redrawn, and draws it again from it", async () => {
    const moka = boarded();
    settle(moka.stories![0], "林", (element) => {
      element.turnaround = {
        takes: [
          {
            assetIds: ["asset-hero-sheet-new"],
            createdAt: "2027-01-01T00:00:00.000Z",
          },
        ],
      };
    });
    openAtBoard(moka);

    expect(screen.getByTestId("story-kf-stale-ref-0")).toBeDefined();
    fireEvent.click(screen.getByTestId("story-act-redraw-stale-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.kind).toBe("keyframeArt");
    expect(starts[0]!.items).toHaveLength(1);
    expect(starts[0]!.items[0]?.inputs?.map((input) => input.assetId)).toEqual([
      "asset-hero-sheet-new",
    ]);
  });

  it("marks a clip made before its frame changed, and keeps it playable", () => {
    const moka = boarded();
    const frame = moka.stories![0].chapters[0]!.acts[0]!.keyframes[0]!;
    frame.art = {
      takes: [
        {
          assetIds: ["asset-frame-new"],
          createdAt: "2027-01-01T00:00:00.000Z",
        },
      ],
    };
    openAtBoard(moka);

    expect(screen.getByTestId("story-act-video-stale-0")).toBeDefined();
    // The older clip is marked, not taken away.
    expect(screen.getByTestId("story-act-video-0")).toBeDefined();
    const preview = screen
      .getByTestId("story-act-video-0")
      .querySelector("img");
    // The clip leads with its own first frame, not with the frame that was
    // drawn after it was made.
    expect(preview?.getAttribute("src")).toContain("asset-act-video");
    expect(preview?.style.aspectRatio).toBe("16 / 9");

    // The same picture stands under the clip as it is watched large, so the
    // window is not empty before the file has a frame to be painted.
    fireEvent.click(screen.getByTestId("story-act-video-0"));
    const watched = screen.getByTestId("story-lightbox").querySelector("video");
    expect(watched?.getAttribute("poster")).toContain("asset-act-video");
  });

  it("adds a picture to the shot's own reference list", async () => {
    openAtBoard(boarded());
    const image = useProjectStore.getState().moka?.resources.images[0];
    expect(image).toBeDefined();

    fireEvent.click(screen.getByTestId("story-kf-ref-add-0"));
    fireEvent.click(screen.getByTestId("story-kf-ref-library-0"));
    fireEvent.click(screen.getByTestId(`story-library-${image!.id}`));

    await waitFor(() =>
      expect(screen.getByTestId("story-kf-ref-0-1")).toBeDefined(),
    );
    // The picture stands beside the one the board recognized, in one list.
    expect(acts()[0]?.keyframes[0]?.references).toEqual([
      { elementId: ids.hero, name: "林" },
      { assetId: image!.id, name: image!.name },
    ]);
  });

  it("narrows the shelf and the elements while a picture is looked for", () => {
    openAtBoard(boarded());

    fireEvent.click(screen.getByTestId("story-kf-ref-add-0"));
    fireEvent.click(screen.getByTestId("story-kf-ref-library-0"));
    const shelf = screen.getByTestId("story-library");
    expect(shelf.querySelectorAll(".story-pick")).toHaveLength(6);
    fireEvent.change(screen.getByTestId("story-library-search"), {
      target: { value: "partner" },
    });
    expect(shelf.querySelectorAll(".story-pick")).toHaveLength(1);
    fireEvent.change(screen.getByTestId("story-library-search"), {
      target: { value: "nothing-like-it" },
    });
    expect(screen.getByTestId("story-library-no-match").textContent).toBe(
      "No asset matches “nothing-like-it”",
    );
    fireEvent.click(within(shelf).getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByTestId("story-kf-ref-add-0"));
    fireEvent.click(screen.getByTestId("story-kf-ref-element-0"));
    const picker = screen.getByTestId("story-element-picker");
    expect(picker.querySelectorAll(".story-pick")).toHaveLength(4);
    fireEvent.change(screen.getByTestId("story-element-search"), {
      target: { value: "末班" },
    });
    expect(picker.querySelectorAll(".story-pick")).toHaveLength(1);
    fireEvent.change(screen.getByTestId("story-element-search"), {
      target: { value: "zzz" },
    });
    expect(screen.getByTestId("story-element-no-match").textContent).toBe(
      "No story element matches “zzz”",
    );
  });

  it("draws a new reference into the act's own cast", async () => {
    openAtBoard(boarded());

    fireEvent.click(screen.getByTestId("story-act-new-ref-0"));
    fireEvent.change(screen.getByTestId("add-element-kind"), {
      target: { value: "prop" },
    });
    fireEvent.change(screen.getByTestId("add-element-name"), {
      target: { value: "旧怀表" },
    });
    fireEvent.change(screen.getByTestId("add-element-description"), {
      target: { value: "一只停在十一点的旧怀表" },
    });
    fireEvent.click(screen.getByTestId("add-element-confirm"));

    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.kind).toBe("elementArt");
    const [item] = starts[0]!.items;
    expect(item?.target).toMatchObject({
      kind: "elementArt",
      view: "main",
    });
    const added = story().elements.find((element) => element.name === "旧怀表");
    expect(added).toBeDefined();
    expect(acts()[0]?.propIds).toContain(added?.id);
    // The new place is open in front of the reader while its picture is drawn.
    expect(screen.getByTestId("story-picture-inspector")).toBeDefined();
  });

  it("draws the pictures the words of a shot name, in the order they appear", async () => {
    openAtBoard(boarded());

    // The board is written and the picture is one press away: nothing about a
    // table has to be agreed to before what is written in it is drawn.
    fireEvent.click(screen.getByTestId("story-act-draw-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    const [item] = starts[0]!.items;
    expect(starts[0]!.kind).toBe("keyframeArt");
    // The shot's words name the picture that travels with it, in the order the
    // names first appear; a name left as plain words carries nothing.
    expect(item?.inputs?.map((input) => input.assetId)).toEqual([
      "asset-partner-sheet",
    ]);
    expect(item?.prompt).toContain("1. 周");
    expect(item?.prompt).not.toContain("旧车票");
  });

  it("draws a shot whose words name nothing from the act's cast", async () => {
    const moka = boarded();
    const frame = moka.stories![0]!.chapters[0]!.acts[0]!.keyframes[0]!;
    frame.content = "雨下个不停。";
    frame.references = undefined;
    frame.art = { takes: [] };
    openAtBoard(moka);

    // The act's cast stands in the shot's own list, picture by picture.
    expect(
      screen.getByTestId("story-kf-refs-0").querySelectorAll(".story-ref-item"),
    ).toHaveLength(4);

    fireEvent.click(screen.getByTestId("story-act-draw-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    const item = starts[0]!.items.find((each) =>
      each.id.includes(ids.frameFirst),
    );
    // The first pictures the story's limit allows, in the act's own order.
    expect(item?.inputs?.map((input) => input.assetId)).toEqual([
      ids.heroSheet,
      "asset-partner-sheet",
      ids.sceneMain,
    ]);
    expect(item?.prompt).toContain("1. 林 —");
  });

  it("takes one of the act's pictures off a shot, keeping the rest", async () => {
    const moka = boarded();
    const frame = moka.stories![0]!.chapters[0]!.acts[0]!.keyframes[0]!;
    frame.content = "雨下个不停。";
    frame.references = undefined;
    openAtBoard(moka);

    fireEvent.click(screen.getByTestId("story-kf-ref-remove-0-0"));
    await waitFor(() =>
      expect(
        acts()[0]?.keyframes[0]?.references?.map((ref) => ref.elementId),
      ).toEqual([ids.partner, ids.scene, ids.prop]),
    );
    // What is left stays on the shot as its own list.
    expect(
      screen.getByTestId("story-kf-refs-0").querySelectorAll(".story-ref-item"),
    ).toHaveLength(3);
  });

  it("leaves a shot the reader emptied with nothing to fall back on", async () => {
    const moka = boarded();
    const frame = moka.stories![0]!.chapters[0]!.acts[0]!.keyframes[0]!;
    frame.content = "雨下个不停。";
    frame.references = undefined;
    openAtBoard(moka);

    // Every picture the act stands in is taken off, one at a time.
    for (let taken = 0; taken < 4; taken += 1) {
      fireEvent.click(screen.getByTestId("story-kf-ref-remove-0-0"));
    }
    await waitFor(() =>
      expect(acts()[0]?.keyframes[0]?.references).toEqual([]),
    );
    // The act's cast is not put back in the place of what was taken away.
    expect(
      screen.getByTestId("story-kf-refs-0").querySelectorAll(".story-ref-item"),
    ).toHaveLength(0);
  });

  it("shows the ask as it will be sent, with the mentioned names and their pictures", () => {
    openAtBoard(boarded());
    // The scaffolding the template writes — the episode, the framing, the look
    // — stands around the shot's own words as the greyed part of the cell.
    const prompt = screen.getByTestId("story-kf-prompt-0").textContent ?? "";
    expect(prompt).toContain('One still frame of a film, from "第一章 站台"');
    expect(prompt).toContain("It is a wide shot");
    expect(prompt).toContain("in the film's own look: 现代都市风");
    expect(prompt).toContain("1. 林 — ");
    // The one name the words mention stands as a chip, and its picture rides.
    const cell = screen.getByTestId("story-kf-content-0");
    const chips = cell.querySelectorAll("[data-mention-name]");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toBe("林");
    expect(chips[0]?.className).toContain("is-carried");
    const thumbs = screen.getByTestId("story-kf-refs-0");
    expect(thumbs.querySelectorAll(".story-ref-thumb")).toHaveLength(1);
    expect(thumbs.querySelector("img")?.getAttribute("src")).toContain(
      ids.heroSheet,
    );
  });

  it("keeps what moves beside the picture's words, out of the picture's ask", async () => {
    openAtBoard(boarded());
    const prompt = screen.getByTestId("story-kf-prompt-0").textContent ?? "";
    // The still frame's ask no longer names the camera's travel; that belongs
    // to the clip, and the motion is a field of its own.
    expect(prompt).not.toContain("pushIn");
    const field = screen.getByTestId(
      "story-kf-motion-0",
    ) as HTMLTextAreaElement;
    expect(field.value).toBe("灯光一盏一盏亮起来，林抬头看向站牌。");
    fireEvent.change(field, { target: { value: "灯灭了，雨声更响。" } });
    fireEvent.blur(field);
    await waitFor(() =>
      expect(story().chapters[0]!.acts[0]!.keyframes[0]!.motion).toBe(
        "灯灭了，雨声更响。",
      ),
    );
  });

  it("offers the shot's own references and the act's cast after an @", async () => {
    const moka = boarded();
    moka.stories![0]!.chapters[0]!.acts[0]!.keyframes[0]!.references = [
      { elementId: ids.hero, name: "林" },
      { elementId: ids.scene, name: "车厢背面" },
    ];
    openAtBoard(moka);
    const field = screen.getByTestId("story-kf-content-0");
    typeAtEnd(field, "看@");
    const offer = await screen.findByTestId("story-kf-content-0-offer");
    const offered = within(offer)
      .getAllByRole("option")
      .map((option) => option.textContent);
    // The shot's own list first, then the elements the act keeps at its top,
    // each name once: 林 is on both lists and is offered once.
    expect(offered).toEqual(["林", "车厢背面", "周", "末班车车厢", "旧车票"]);
    fireEvent.click(within(offer).getByRole("option", { name: "车厢背面" }));
    await waitFor(() =>
      expect(field.querySelector("[data-mention-name]")?.textContent).toBe(
        "车厢背面",
      ),
    );
    fireEvent.blur(field);
    await waitFor(() =>
      expect(story().chapters[0]!.acts[0]!.keyframes[0]!.content).toBe(
        "看`车厢背面` ",
      ),
    );
    // Naming a picture the list already holds adds nothing to it.
    expect(acts()[0]?.keyframes[0]?.references).toHaveLength(2);
  });

  it("keeps the reference while its name is taken out of the words", async () => {
    openAtBoard(boarded());
    const field = screen.getByTestId("story-kf-content-0");
    expect(screen.getByTestId("story-kf-ref-0-0")).toBeDefined();
    field.querySelector("[data-mention-name]")?.remove();
    fireEvent.input(field);
    await waitFor(() =>
      expect(field.querySelector("[data-mention-name]")).toBeNull(),
    );
    fireEvent.blur(field);
    await waitFor(() =>
      expect(story().chapters[0]!.acts[0]!.keyframes[0]!.content).toBe(
        "雨中的站台，立在灯下。",
      ),
    );
    // The picture stays on the shot's list; the words only stopped naming it.
    expect(screen.getByTestId("story-kf-ref-0-0")).toBeDefined();
  });

  it("marks a name the limit leaves behind, and one nobody has drawn", () => {
    const moka = boarded();
    const held = moka.stories![0]!;
    held.maxReferenceImages = 2;
    held.chapters[0]!.acts[0]!.keyframes[0]!.content =
      "`林`看着`周`，`末班车车厢`里很暗。";
    held.chapters[0]!.acts[0]!.keyframes[0]!.references = [
      { elementId: ids.hero, name: "林" },
      { elementId: ids.partner, name: "周" },
      { elementId: ids.scene, name: "末班车车厢" },
    ];
    openAtBoard(moka);
    const cell = screen.getByTestId("story-kf-content-0");
    const chips = Array.from(cell.querySelectorAll("[data-mention-name]"));
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "林",
      "周",
      "末班车车厢",
    ]);
    expect(chips[0]?.className).toContain("is-carried");
    expect(chips[1]?.className).toContain("is-carried");
    // The third mention is drawn and over the limit: its words stay, its
    // picture stands dimmed among the ones that travel.
    expect(chips[2]?.className).toContain("is-beyond");
    expect(
      screen
        .getByTestId("story-kf-refs-0")
        .querySelectorAll(".story-ref-thumb"),
    ).toHaveLength(3);
  });

  it("leaves a mentioned name nobody has drawn to the words", () => {
    const moka = buildStoryMokaFile();
    moka.stories![0]!.chapters[0]!.acts[0]!.keyframes[0]!.content =
      "`旧车票`攥在手里。";
    moka.stories![0]!.chapters[0]!.acts[0]!.keyframes[0]!.references = [
      { elementId: ids.prop, name: "旧车票" },
    ];
    openAtBoard(moka);
    const chip = screen
      .getByTestId("story-kf-content-0")
      .querySelector("[data-mention-name]");
    expect(chip?.className).toContain("is-undrawn");
    // The reference stays on the list, standing in with its kind's placeholder
    // until a drawing of it is made.
    const tile = screen.getByTestId("story-kf-ref-0-0");
    const picture = tile.querySelector("img");
    expect(picture?.getAttribute("src")).toBe("/story/element-prop.svg");
    expect(picture?.getAttribute("alt")).toBe("旧车票");
  });

  it("stands an undrawn element of each kind in with its own placeholder", () => {
    const moka = buildStoryMokaFile();
    const storyHeld = moka.stories![0]!;
    for (const element of storyHeld.elements ?? []) {
      element.main = { takes: [] };
      element.turnaround = { takes: [] };
    }
    storyHeld.chapters[0]!.acts[0]!.keyframes[0]!.content =
      "`林`在`末班车车厢`里攥着`旧车票`。";
    storyHeld.chapters[0]!.acts[0]!.keyframes[0]!.references = [
      { elementId: ids.hero, name: "林" },
      { elementId: ids.scene, name: "末班车车厢" },
      { elementId: ids.prop, name: "旧车票" },
    ];
    openAtBoard(moka);
    const sources = [0, 1, 2].map((at) =>
      screen
        .getByTestId(`story-kf-ref-0-${at}`)
        .querySelector("img")
        ?.getAttribute("src"),
    );
    expect(sources).toEqual([
      "/story/element-character.svg",
      "/story/element-scene.svg",
      "/story/element-prop.svg",
    ]);
    // The stand-in is still a door: the inspector it opens is where the
    // drawing is made.
    expect(
      (screen.getByTestId("story-kf-ref-0-0") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("writes the reference limit the reader sets beside the models", async () => {
    openAtBoard(boarded());
    const input = screen.getByTestId("story-max-refs") as HTMLInputElement;
    expect(input.value).toBe("3");
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.blur(input);
    await waitFor(() => expect(story().maxReferenceImages).toBe(5));
  });

  it("keeps the table open after the board is written, with nothing in it to agree to", async () => {
    openAtBoard(boarded());
    const first = card(0);

    // A board is argued with rather than sealed: there is no agreement on the
    // table and none on its pictures, so a cell written after the board was
    // written is simply the board.
    expect(within(first).queryByTestId("story-act-keys-0")).toBeNull();
    expect(within(first).queryByTestId("story-act-unlock-0")).toBeNull();
    expect(within(first).queryByTestId("story-act-keys-on-0")).toBeNull();
    expect(
      within(first).queryByTestId("story-act-images-confirm-0"),
    ).toBeNull();
    expect(within(first).queryByTestId("story-kf-slot-0-confirm")).toBeNull();

    fireEvent.change(within(first).getByTestId("story-kf-size-1"), {
      target: { value: "medium" },
    });
    await waitFor(() =>
      expect(acts()[0]?.keyframes[1]?.shotSize).toBe("medium"),
    );
    expect(useHistoryStore.getState().undoStack.length).toBeGreaterThan(0);
  });

  it("waits on the shot being drawn while the rest of the act stays askable", async () => {
    openAtBoard(withASecondAct());
    const first = card(0);

    // Two shots of the one act are asked for on their own, one after the other:
    // two batches out for one act, which is what nothing about them needs.
    fireEvent.click(within(first).getByTestId("story-kf-slot-0-generate"));
    confirmDraw();
    await waitFor(() => expect(starts).toHaveLength(1));
    fireEvent.click(within(first).getByTestId("story-kf-slot-1-generate"));
    confirmDraw();
    await waitFor(() => expect(starts).toHaveLength(2));

    // The shots being drawn say so, offer no second ask of themselves — and the
    // shot nobody is drawing is still one a reader can ask for on its own.
    for (const at of [0, 1]) {
      const slot = within(first).getByTestId(`story-kf-slot-${at}`);
      expect(slot.textContent).toContain("Drawing…");
      expect(
        within(slot).queryByTestId(`story-kf-slot-${at}-generate`),
      ).toBeNull();
    }
    const own = within(first).getByTestId(
      "story-kf-slot-2-generate",
    ) as HTMLButtonElement;
    expect(own.disabled).toBe(false);
    // Which is also what the act's own button and the board's count: the work
    // still to ask for, not the work already handed over.
    expect(within(first).getByTestId("story-act-draw-0").textContent).toBe(
      "Draw the missing frames (1)",
    );
    // The board counts the work of every act it holds, the second one's shot
    // among it: nothing about a board is left out of what it offers to do.
    expect(screen.getByTestId("story-board-draw-missing").textContent).toBe(
      "Draw every missing frame (2)",
    );

    // One of the two answers while the other is still being painted: the place
    // it landed in shows it, the place still being drawn still says so, and the
    // rest of the episode is the reader's throughout — a batch drawing one shot
    // is not the whole board waiting.
    landed[`keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`] = [
      "asset-frame-first",
    ];
    await comesBack(1);
    await waitFor(() =>
      expect(
        within(first).getByTestId("story-kf-slot-0").querySelector("img"),
      ).not.toBeNull(),
    );
    expect(within(first).getByTestId("story-kf-slot-1").textContent).toContain(
      "Drawing…",
    );
    const second = card(1);
    // The second act's own table and its own ask are the reader's throughout:
    // a batch drawing one act is not the whole board waiting.
    expect(
      (within(second).getByTestId("story-kf-size-0") as HTMLSelectElement)
        .disabled,
    ).toBe(false);
    expect(
      (within(second).getByTestId("story-act-draw-1") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByTestId("story-board-regenerate") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("says where a frame stands in line until its painter takes it up", async () => {
    openAtBoard(withThreeUndrawnShots());
    const first = card(0);
    fireEvent.click(within(first).getByTestId("story-act-draw-0"));
    await waitFor(() => expect(starts).toHaveLength(1));

    // The batch is out with one piece at the painter and the rest waiting for
    // a slot: waiting is not drawing, and the place says which it is.
    replaceLanded({ __keep_running: [] });
    replaceHeld(
      held.map((job) =>
        job.id === "job-1"
          ? {
              ...job,
              items: job.items.map((item, at) => ({
                ...item,
                status: at === 0 ? ("running" as const) : ("queued" as const),
              })),
            }
          : job,
      ),
    );
    await comesBack(1);

    expect(within(first).getByTestId("story-kf-slot-0").textContent).toContain(
      "Drawing…",
    );
    expect(within(first).getByTestId("story-kf-slot-1").textContent).toContain(
      "Queued 1/2",
    );
    expect(within(first).getByTestId("story-kf-slot-2").textContent).toContain(
      "Queued 2/2",
    );
  });

  it("says a stop was heard while a batch still in line is ending", async () => {
    openAtBoard(withThreeUndrawnShots());
    const first = card(0);
    fireEvent.click(within(first).getByTestId("story-act-draw-0"));
    await waitFor(() => expect(starts).toHaveLength(1));

    // The batch is out with every piece still waiting for a slot, so the press
    // itself is the only thing that can say the stop was heard.
    replaceHeld(
      held.map((job) =>
        job.id === "job-1"
          ? {
              ...job,
              items: job.items.map((item) => ({
                ...item,
                status: "queued" as const,
              })),
            }
          : job,
      ),
    );
    fireEvent.click(within(first).getByTestId("story-act-running-cancel"));

    await waitFor(() =>
      expect(
        within(first).getByTestId("story-act-running-stopping").textContent,
      ).toBe("Stopping…"),
    );
    expect(within(first).queryByTestId("story-act-running-cancel")).toBeNull();
  });

  it("shows a shot's picture as it lands while the rest are still being drawn", async () => {
    openAtBoard(withUndrawnFrames());
    const first = card(0);
    fireEvent.click(within(first).getByTestId("story-act-draw-0"));
    await waitFor(() => expect(starts).toHaveLength(1));

    // The first of the two answers while the batch is still out: its own place
    // shows the picture rather than waiting for the whole batch to be over.
    landed[`keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`] = [
      "asset-frame-first",
    ];
    await comesBack();
    await waitFor(() =>
      expect(
        within(first)
          .getByTestId("story-kf-slot-0")
          .querySelector("img")
          ?.getAttribute("src"),
      ).toBe(
        `/api/v1/projects/current/assets/asset-frame-first?w=480&project=${goldenNodeIds().project}`,
      ),
    );

    // The one still on its way shows a place being painted, not one drawn.
    expect(within(first).getByTestId("story-kf-slot-1").textContent).toContain(
      "Drawing…",
    );
    expect(
      within(first).getByTestId("story-kf-slot-1").querySelector("img"),
    ).toBeNull();

    // The second lands and the batch is over: the act holds both pictures.
    landed[`keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameSecond}`] = [
      "asset-frame-second",
    ];
    await comesBack();
    await waitFor(() =>
      expect(acts()[0]?.keyframes[1]?.art.takes).toHaveLength(1),
    );
    expect(
      within(first).getByTestId("story-kf-slot-1").querySelector("img"),
    ).not.toBeNull();
  });

  it("says which references are missing rather than refusing to draw", async () => {
    openAtBoard(withoutThePlace());
    expect(screen.getByTestId("story-act-missing-ref-0").textContent).toContain(
      "末班车车厢",
    );

    fireEvent.click(screen.getByTestId("story-act-draw-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(
      starts[0]!.items[0]?.inputs?.map((input) => input.assetId),
    ).not.toContain(ids.sceneMain);
  });

  it("has nothing per frame to agree to: drawn frames are what the clip waits on", () => {
    openAtBoard(withEveryFrame());
    const first = card(0);

    expect(within(first).queryByTestId("story-kf-slot-0-confirm")).toBeNull();
    expect(screen.queryByTestId("story-act-images-confirm-0")).toBeNull();
    // Every frame drawn: the act's clip is one press away.
    expect(
      (screen.getByTestId("story-act-video-again-0") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("waits for every frame to be drawn before the act's clip is asked for", () => {
    const moka = withUndrawnFrames();
    moka.stories![0].chapters[0]!.acts[0]!.video = { takes: [] };
    openAtBoard(moka);
    const go = screen.getByTestId("story-act-video-go-0") as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(go.getAttribute("title")).toContain("every frame");
    // A step-level press is the only agreement the board has, and it says the
    // same thing: the pictures are what is missing.
    fireEvent.click(screen.getByTestId("story-confirm-storyboard"));
    expect(
      screen.getByTestId("story-confirm-gaps-storyboard").textContent,
    ).toContain("2 shots have no frame drawn yet");
  });

  it("takes an act's clip off the shelf without waiting for its frames", async () => {
    const moka = withUndrawnFrames();
    moka.stories![0].chapters[0]!.acts[0]!.video = { takes: [] };
    openAtBoard(moka);

    // The two sources a clip may come from wait behind the row's More; taken
    // from either, the clip is kept as it is.
    fireEvent.click(
      within(screen.getByTestId("story-act-more-0")).getByText("More"),
    );
    const library = screen.getByTestId(
      "story-act-video-library-0",
    ) as HTMLButtonElement;
    expect(library.disabled).toBe(false);
    expect(
      (screen.getByTestId("story-act-video-upload-0") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (
        screen.getByTestId("story-act-video-upload-input-0") as HTMLInputElement
      ).getAttribute("accept"),
    ).toBe("video/*");

    fireEvent.click(library);
    expect(screen.getByTestId("story-library")).toBeDefined();
    fireEvent.click(screen.getByTestId(`story-library-${ids.actVideo}`));

    // The clip is kept as the act's own, with the frames still undrawn.
    await waitFor(() =>
      expect(acts()[0]?.video.takes.at(-1)?.assetIds).toEqual([ids.actVideo]),
    );
    expect(screen.getByTestId("story-act-video-0")).toBeDefined();
  });

  it("films an act once its frames are drawn, for as long as it plans", async () => {
    // The video settings say what a canvas node asks for when nobody says:
    // three seconds here. What a board plans is its own, and the act is asked
    // for the five seconds its shots add up to rather than for the default.
    filmingAt(3);
    openAtBoard(withoutTheClip());
    // Every frame is drawn, which is the whole of what the ask waits on.
    expect(
      (screen.getByTestId("story-act-video-go-0") as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.click(screen.getByTestId("story-act-video-go-0"));
    confirmFilm();
    await waitFor(() => expect(starts).toHaveLength(1));
    const [item] = starts[0]!.items;
    expect(starts[0]!.kind).toBe("actVideo");
    expect(item?.capability).toBe("video");
    expect(item?.params?.seconds).toBe(clampSeconds(5_000));
    expect(item?.prompt).toContain("about 5 seconds");
    expect(item?.params?.ratio).toBe(story().brief.aspect);
    // Two shots, two pictures, and neither frame given a shoot role: they
    // travel as the references the clip is drawn from, and the mode says so.
    expect(item?.inputs?.map((input) => input.role)).toEqual([
      "reference",
      "reference",
    ]);
    expect(item?.params?.mode).toBe("reference");
  });

  it("gives every drawn frame a shoot role, and writes the one the reader picks", async () => {
    openAtBoard(withEveryFrame());
    const first = card(0);

    const head = within(first).getByTestId(
      "story-kf-role-0",
    ) as HTMLSelectElement;
    expect(head.value).toBe("reference");
    expect(head.options.length).toBe(3);
    expect(head.getAttribute("aria-label")).toContain("Shoot role");
    // Nothing is drawn after the last frame, so it cannot open a pair; every
    // frame before it may.
    const tail = within(first).getByTestId(
      "story-kf-role-1",
    ) as HTMLSelectElement;
    expect([...tail.options].map((option) => option.value)).toEqual([
      "reference",
      "firstFrame",
    ]);

    fireEvent.change(head, { target: { value: "firstLastFrame" } });
    await waitFor(() =>
      expect(acts()[0]?.keyframes[0]?.filmRole).toBe("firstLastFrame"),
    );
  });

  it("takes the closing frame's role away once the frame before it pairs with it", async () => {
    openAtBoard(withEveryFrame());
    const first = card(0);

    const tail = () =>
      within(first).getByTestId("story-kf-role-1") as HTMLSelectElement;
    expect(tail().disabled).toBe(false);

    fireEvent.change(within(first).getByTestId("story-kf-role-0"), {
      target: { value: "firstLastFrame" },
    });
    await waitFor(() => expect(tail().disabled).toBe(true));
    expect(tail().getAttribute("title")).toContain("closing frame");

    // Taken back, the closing frame is the reader's again.
    fireEvent.change(within(first).getByTestId("story-kf-role-0"), {
      target: { value: "reference" },
    });
    await waitFor(() => expect(tail().disabled).toBe(false));
  });

  it("shows a role the board can no longer offer rather than rewriting it", () => {
    const moka = withEveryFrame();
    moka.stories![0].chapters[0]!.acts[0]!.keyframes[1]!.filmRole =
      "firstLastFrame";
    openAtBoard(moka);

    const tail = within(card(0)).getByTestId(
      "story-kf-role-1",
    ) as HTMLSelectElement;
    expect(tail.value).toBe("firstLastFrame");
    expect(
      [...tail.options].find((option) => option.value === "firstLastFrame")
        ?.disabled,
    ).toBe(true);
  });

  it("offers no shoot role when the story is cut shot by shot", () => {
    openAtBoard(withFilmedShot());
    expect(screen.queryByTestId("story-kf-role-0")).toBeNull();
  });

  it("asks for the act's clip again from the row that plays it", async () => {
    openAtBoard(withoutTheClip());

    // While no clip is there the first ask is the only one.
    expect(screen.queryByTestId("story-act-video-again-0")).toBeNull();
    fireEvent.click(screen.getByTestId("story-act-video-go-0"));
    confirmFilm();
    await waitFor(() => expect(starts).toHaveLength(1));
    await comesBack();

    // The clip is home, and the same ask stands beside it: a reader who does
    // not like what came back is not left holding it.
    const again = screen.getByTestId(
      "story-act-video-again-0",
    ) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    fireEvent.click(again);
    confirmFilm();
    await waitFor(() => expect(starts).toHaveLength(2));
    expect(starts[1]!.kind).toBe("actVideo");
    expect(starts[1]!.items[0]?.id).toBe(starts[0]!.items[0]?.id);
  });

  it("plays a clip filmed in pieces as the pieces, one after another", () => {
    const moka = boarded();
    const held = moka.stories![0].chapters[0]!.acts[0]!;
    held.video = {
      takes: [
        {
          assetIds: ["asset-piece-one", "asset-piece-two"],
          createdAt: T0,
        },
      ],
    };
    openAtBoard(moka);
    fireEvent.click(screen.getByTestId("story-act-video-0"));

    const lightbox = screen.getByTestId("story-lightbox");
    const piece = () => screen.getByTestId("story-lightbox-piece").textContent;
    expect(piece()).toBe("Part 1 of 2");
    // The clip opens on its poster rather than playing itself: playback is
    // the reader's to begin.
    expect(lightbox.querySelector("video")?.autoplay).toBe(false);
    expect(lightbox.querySelector("video")?.getAttribute("src")).toContain(
      "asset-piece-one",
    );

    // The first piece ending opens the second, which is the order the card and
    // the finished cut read them in.
    fireEvent.ended(lightbox.querySelector("video")!);
    expect(piece()).toBe("Part 2 of 2");
    expect(lightbox.querySelector("video")?.getAttribute("src")).toContain(
      "asset-piece-two",
    );
  });

  it("names the video model one act is filmed by, and asks that act of it", async () => {
    filmingWithCeiling(15);
    openAtBoard(withoutTheClip());

    const picker = screen.getByTestId(
      "story-act-video-model-0",
    ) as HTMLSelectElement;
    expect(picker.value).toBe("");
    fireEvent.change(picker, { target: { value: "filmer" } });
    expect(acts()[0]?.videoModel).toBe("filmer");

    fireEvent.click(screen.getByTestId("story-act-video-go-0"));
    confirmFilm();
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]?.kind).toBe("actVideo");
    expect(starts[0]?.model).toBe("filmer");
    await comesBack();

    // Clearing the choice hands the act back to the step's own model.
    fireEvent.change(
      screen.getByTestId("story-act-video-model-0") as HTMLSelectElement,
      { target: { value: "" } },
    );
    expect(acts()[0]?.videoModel).toBeUndefined();
  });

  it("asks a long act in pieces, and says so beside the plan", async () => {
    // The video model films fifteen seconds at a time and the act runs for
    // eighteen: it is filmed in two pieces, and the row says so before the ask.
    const moka = withoutTheClip();
    const held = moka.stories![0].chapters[0]!.acts[0]!;
    for (const keyframe of held.keyframes) keyframe.durationMs = 9_000;
    filmingWithCeiling(15);
    openAtBoard(moka);

    expect(screen.getByTestId("story-act-split-0").textContent).toContain("2");
    fireEvent.click(screen.getByTestId("story-act-video-go-0"));
    confirmFilm();
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.items.map((item) => item.params?.seconds)).toEqual([
      9, 9,
    ]);
    expect(starts[0]!.items.map((item) => item.id)).toEqual([
      `actVideo:${ids.chapterFirst}:${ids.act}:1`,
      `actVideo:${ids.chapterFirst}:${ids.act}:2`,
    ]);
  });

  it("says out loud when a shot cannot be cut and the clip is cut short", async () => {
    // A shot has no end to be cut at, so a shot longer than the model films is
    // made as long as it can be, and the row says what the whole ask comes to.
    const moka = withoutTheClip();
    const held = moka.stories![0].chapters[0]!.acts[0]!;
    for (const keyframe of held.keyframes) keyframe.durationMs = 900_000;
    filmingWithCeiling(15);
    openAtBoard(moka);

    expect(screen.getByTestId("story-act-clamp-0").textContent).toContain("30");
    fireEvent.click(screen.getByTestId("story-act-video-go-0"));
    confirmFilm();
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.items.map((item) => item.params?.seconds)).toEqual([
      15, 15,
    ]);
  });

  it("films shot by shot, each from its own frame to the next", async () => {
    const moka = withEveryFrame();
    const act = moka.stories![0].chapters[0]!.acts[0]!;
    act.keyframes[1]!.art = {
      takes: [{ assetIds: ["asset-second-frame"], createdAt: T0 }],
    };
    openAtBoard(moka);

    // The act already holds a clip, so changing how clips are made is a
    // question rather than a switch — and the clips already made stay put.
    fireEvent.click(screen.getByTestId("story-granularity-keyframe"));
    expect(screen.getByTestId("change-granularity")).toBeDefined();
    fireEvent.click(screen.getByTestId("change-granularity-confirm"));
    await waitFor(() => expect(story().shotGranularity).toBe("keyframe"));
    expect(acts()[0]?.video.takes).toHaveLength(1);

    fireEvent.click(screen.getByTestId("story-kf-video-0"));
    confirmFilm();
    await waitFor(() => expect(starts).toHaveLength(1));
    let item = starts[0]!.items[0];
    expect(starts[0]!.kind).toBe("keyframeVideo");
    expect(item?.inputs?.map((input) => [input.role, input.assetId])).toEqual([
      ["firstFrame", ids.frameArt],
      ["lastFrame", "asset-second-frame"],
    ]);
    expect(item?.params?.seconds).toBe(clampSeconds(2_000));

    // One shot is filmed at a time: the act's other shots wait for this one to
    // come home before they are asked for.
    await comesBack();

    // The last shot has nothing after it to end on, so it is filmed from its
    // own frame alone.
    fireEvent.click(screen.getByTestId("story-kf-video-1"));
    confirmFilm();
    await waitFor(() => expect(starts).toHaveLength(2));
    item = starts[1]!.items[0];
    expect(item?.inputs?.map((input) => input.role)).toEqual(["firstFrame"]);
  });

  it("films one act by shot while the telling's own habit stays put", async () => {
    openAtBoard(withEveryFrame());
    // The act already holds a clip, so its own switch is a question too — and
    // what it changes is this act, not every act beside it.
    expect(
      screen.queryByTestId("story-act-granularity-keyframe-0"),
    ).not.toBeNull();
    fireEvent.click(screen.getByTestId("story-act-granularity-keyframe-0"));
    expect(screen.getByTestId("change-act-granularity-0")).toBeDefined();
    fireEvent.click(screen.getByTestId("change-act-granularity-0-confirm"));
    await waitFor(() =>
      expect(story().chapters[0].acts[0].shotGranularity).toBe("keyframe"),
    );
    expect(story().shotGranularity).toBe("act");

    // The row that belongs to the shot is the one that films it.
    fireEvent.click(screen.getByTestId("story-kf-video-0"));
    confirmFilm();
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.kind).toBe("keyframeVideo");
  });

  it("asks for a shot's clip again from the row that holds it", async () => {
    openAtBoard(withFilmedShot());
    const first = card(0);

    // The shot holds a clip, and its row says what may be done about it: the
    // take asked over beside the take settled on — while the shot next to it,
    // holding nothing, still asks for its first.
    const preview = within(first).getByTestId("story-kf-video-0");
    expect(preview.querySelector("img")?.getAttribute("src")).toContain(
      "asset-first-shot-clip",
    );
    fireEvent.click(preview);
    expect(
      screen
        .getByTestId("story-lightbox")
        .querySelector("video")
        ?.getAttribute("src"),
    ).toContain("asset-first-shot-clip");
    fireEvent.click(screen.getByTestId("story-lightbox-close"));
    const again = within(first).getByTestId(
      "story-kf-video-again-0",
    ) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(within(first).getByTestId("story-kf-video-1")).toBeDefined();

    fireEvent.click(again);
    confirmFilm();
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.kind).toBe("keyframeVideo");
    expect(starts[0]!.items[0]?.id).toBe(
      `keyframeVideo:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`,
    );
  });
});
