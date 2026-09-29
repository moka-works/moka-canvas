import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  configureTheWholeStudio,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openStoryRoom,
  projectHome,
} from "./helpers";

// The whole telling is walked in one test — five steps, every ask through a
// stand-in — which needs longer than the suite's own budget for one case.
test.describe.configure({ timeout: 60_000 });

/**
 * Taking a telling into the other two rooms.
 *
 * A whole telling is taken as far as a filmed, voiced and scored act, and then
 * handed over twice: once into a board of its own — every card naming the file
 * the shelf already holds, wired to what it was made from, carrying the ask it
 * was made with — and once into a cut of its own in the cutting room.
 */

/** What the server holds of the board this test asks for. */
async function persistedBoard(page: Page): Promise<{
  name: string;
  cards: { kind: string; title: string; assetId?: string; prompt?: string }[];
  ports: string[];
  stories: number;
}> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        canvas?: {
          name?: string;
          nodes?: {
            kind?: string;
            title?: string;
            data?: {
              assetId?: string;
              generation?: { prompt?: string };
            };
          }[];
          edges?: { target?: { portId?: string } }[];
        }[];
        stories?: unknown[];
      };
    };
    const boards = body.moka?.canvas ?? [];
    const made = boards[boards.length - 1];
    return {
      name: made?.name ?? "",
      cards: (made?.nodes ?? []).map((node) => ({
        kind: node.kind ?? "",
        title: node.title ?? "",
        ...(node.data?.assetId === undefined
          ? {}
          : { assetId: node.data.assetId }),
        ...(node.data?.generation?.prompt === undefined
          ? {}
          : { prompt: node.data.generation.prompt }),
      })),
      ports: (made?.edges ?? []).map((edge) => edge.target?.portId ?? ""),
      stories: (body.moka?.stories ?? []).length,
    };
  });
}

/** What the server holds of the cut this test asks for, and of the telling. */
async function persistedCut(page: Page): Promise<{
  names: string[];
  clips: { kind?: string; assetId?: string; startMs?: number }[];
  assembled?: string;
}> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        timelines?: {
          name?: string;
          clips?: { kind?: string; assetId?: string; startMs?: number }[];
        }[];
        stories?: { edit?: { timelineId?: string } }[];
      };
    };
    const timelines = body.moka?.timelines ?? [];
    const made = timelines[timelines.length - 1];
    return {
      names: timelines.map((timeline) => timeline.name ?? ""),
      clips: (made?.clips ?? []).map((clip) => ({
        kind: clip.kind,
        assetId: clip.assetId,
        startMs: clip.startMs,
      })),
      ...(body.moka?.stories?.[0]?.edit?.timelineId === undefined
        ? {}
        : { assembled: body.moka.stories[0].edit.timelineId }),
    };
  });
}

test("a telling is imported into a board, and into a cut of its own", async ({
  page,
}) => {
  const home = projectHome("story-import");
  await forgetProjects();
  await configureTheWholeStudio();
  try {
    await page.goto("/");
    await createProject(page, join(home, "project"), "Story Import");
    await openStoryRoom(page);
    await newStory(page, "Rain at Night");

    // A premise, the chapters it is told in, and the cast they hold.
    await page
      .getByTestId("story-idea-input")
      .fill("Eleven at night, and the last train stops where it should not.");
    await page.getByTestId("story-idea-duration-3").click();
    await page.getByTestId("story-confirm-idea").click();
    await expect(page.getByTestId("story-step-body-outline")).toBeVisible();
    await page.getByTestId("story-outline-start").click();
    await expect(page.locator(".story-chapter")).toHaveCount(3, {
      timeout: 30_000,
    });
    await page.getByTestId("story-confirm-outline").click();

    await page.getByTestId("story-step-elements").click();
    await page.getByTestId("story-elements-recognise").click();
    await expect(page.locator(".story-element")).toHaveCount(4, {
      timeout: 30_000,
    });
    await page.getByTestId("story-elements-draw-all").click();
    await expect(page.getByTestId("story-elements-views-all")).toBeEnabled({
      timeout: 60_000,
    });
    await page.getByTestId("story-elements-views-all").click();
    await expect(
      page
        .getByTestId("story-element-character-Keeper")
        .getByTestId("story-slot-turnaround")
        .locator("img"),
    ).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("story-confirm-elements").click();
    await expect(page.getByTestId("story-step-storyboard")).toBeEnabled({
      timeout: 30_000,
    });

    // One episode is boarded, framed and filmed; the first act is voiced and
    // scored as well, and the second act is framed and filmed so that the step
    // settles and the fifth step's own import stands open.
    await page.getByTestId("story-step-storyboard").click();
    await page.getByTestId("story-board-generate").click();
    const firstAct = page.getByTestId("story-act-0");
    await expect(firstAct.getByTestId("story-table")).toBeVisible({
      timeout: 30_000,
    });
    await firstAct.getByTestId("story-act-draw-0").click();
    await expect(
      firstAct.getByTestId("story-kf-slot-0").locator("img"),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      firstAct.getByTestId("story-kf-slot-1").locator("img"),
    ).toBeVisible({ timeout: 60_000 });
    await firstAct.getByTestId("story-act-video-go-0").click();
    await expect(firstAct.getByTestId("story-act-video-0")).toBeVisible({
      timeout: 60_000,
    });
    await firstAct.getByTestId("story-act-voice-go-0").click();
    await expect(firstAct.getByTestId("story-act-voice-count-0")).toBeVisible({
      timeout: 60_000,
    });
    await firstAct.getByTestId("story-act-music-go-0").click();
    await expect(firstAct.getByTestId("story-act-music-0")).toBeVisible({
      timeout: 60_000,
    });

    const secondAct = page.getByTestId("story-act-1");
    await secondAct.getByTestId("story-act-draw-1").click();
    await expect(
      secondAct.getByTestId("story-kf-slot-0").locator("img"),
    ).toBeVisible({ timeout: 60_000 });
    await secondAct.getByTestId("story-act-video-go-1").click();
    await expect(secondAct.getByTestId("story-act-video-1")).toBeVisible({
      timeout: 60_000,
    });
    await page.getByTestId("story-confirm-storyboard").click();
    await expect(page.getByTestId("story-step-body-edit")).toBeVisible();

    // Step four's own button takes the telling into a board of its own, and it
    // stands on the board's own step: the press that settled the step walked
    // the reader on to the fifth.
    await page.getByTestId("story-step-storyboard").click();
    const before = await persistedBoard(page);
    await page.getByTestId("story-import-canvas").click();
    const ask = page.getByTestId("story-import-canvas-dialog");
    await expect(ask).toBeVisible({ timeout: 10_000 });
    await expect(ask.getByLabel("Name")).toHaveValue("Rain at Night");
    await ask.getByLabel("Name").fill("Rain at Night · board");
    await ask.getByRole("button", { name: "Import to canvas" }).click();

    // The reader lands in the board that was made for them, with a tab on it.
    await expect(page.getByTestId("canvas-host")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByTestId("canvas-tab-Rain at Night · board"),
    ).toBeVisible();
    await expect(page.locator(".canvas-tab.is-active")).toContainText(
      "Rain at Night · board",
    );

    // What the board holds is written down rather than only drawn: the cards
    // are read back from the server, once the change has landed there.
    await expect
      .poll(async () => (await persistedBoard(page)).name, { timeout: 30_000 })
      .toBe("Rain at Night · board");
    const made = await persistedBoard(page);
    expect(made.stories).toBe(before.stories);
    // The premise, the episodes, the acts and the shots are cards of words.
    expect(made.cards.map((card) => card.title)).toEqual(
      expect.arrayContaining(["Premise", "1. Chapter 1", "1.1 The platform"]),
    );
    // The drawings and the clip are the files the shelf already holds, and the
    // cards carry the ask they were made with.
    const held = made.cards.filter((card) => card.assetId !== undefined);
    expect(held.length).toBeGreaterThan(3);
    expect(held.every((card) => card.prompt !== undefined)).toBe(true);
    expect(made.cards.some((card) => card.kind === "video")).toBe(true);
    // The wires are the telling's own relations: what a card was made from,
    // and which material an ask was sent. No frame has been given a shoot
    // role, so an act's clip carries its pictures as references and the wires
    // run into the images port.
    expect(made.ports).toEqual(expect.arrayContaining(["prompt", "images"]));

    // Step five's button takes it into a cut of its own.
    await openStoryRoom(page);
    await page.getByTestId("story-step-edit").click();
    await expect(page.getByTestId("story-step-edit-body")).toBeVisible();
    await page.getByTestId("story-import-timeline").click();
    const cut = page.getByTestId("story-import-timeline-dialog");
    await expect(cut).toBeVisible({ timeout: 10_000 });
    await expect(cut.getByLabel("Name")).toHaveValue("Rain at Night · cut");
    await cut
      .getByRole("button", { name: "Import to the cutting room" })
      .click();

    await expect(page.getByTestId("clip-page")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page
        .getByRole("tablist", { name: "Timelines" })
        .getByRole("tab", { name: "Rain at Night · cut" }),
    ).toHaveAttribute("aria-selected", "true");

    await expect
      .poll(async () => (await persistedCut(page)).names, { timeout: 30_000 })
      .toEqual(["Rain at Night · cut"]);
    const handed = await persistedCut(page);
    // The clip of each act, both lines read aloud inside the shots they are
    // said in, and the score under the first — and no captions: the lines are
    // the cutting room's to place.
    expect(handed.clips.map((clip) => clip.kind)).toEqual([
      "video",
      "video",
      "audio",
      "audio",
      "audio",
    ]);
    expect(handed.clips.map((clip) => clip.startMs)).toEqual([
      0, 1_000, 0, 3_000, 0,
    ]);
    // The telling itself assembled nothing: this cut is the reader's own.
    expect(handed.assembled).toBeUndefined();
  } finally {
    forgetHome(home);
  }
});
