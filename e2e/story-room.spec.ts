import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  contrastOf,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openRecent,
  openStoryRoom,
  persistedStoryNames,
  projectHome,
} from "./helpers";

/**
 * The story room is a place of its own.
 *
 * It is reached from the corner menu, above the board and the cutting room,
 * and it opens on the first-run question a project with no story asks. A story
 * is begun under a name and stood on at its first step; the steps that have not
 * been earned say what comes first. What the reader is looking at is kept on
 * the machine, and what the story holds is kept in the document.
 */

async function emptyProject(page: Page, name: string): Promise<string> {
  const home = projectHome("story-room");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), name);
  return home;
}

test("the corner menu leads to the story room, above the board", async ({
  page,
}) => {
  const home = await emptyProject(page, "Story Room");
  await openStoryRoom(page);

  // The room stands empty and says what it is for.
  await expect(page.getByTestId("story-empty")).toBeVisible();
  await expect(
    page.getByText("A story is told here: a premise, the episodes it is told"),
  ).toBeVisible();

  // The corner menu walks between the working pages in telling order, and
  // marks the one being stood on.
  await page.getByRole("button", { name: "Projects menu" }).click();
  const rows = page.getByTestId("home-menu").getByRole("menuitem");
  await expect(rows).toHaveText([
    "Projects",
    "Story",
    "Canvas",
    "Clip",
    "Assets",
  ]);
  await expect(rows.filter({ hasText: "Story" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  // The board is a step away, and the project is not put down on the way.
  await rows.filter({ hasText: "Canvas" }).click();
  await expect(page.getByTestId("canvas-host")).toBeVisible({
    timeout: 10_000,
  });
  await openStoryRoom(page);
  await expect(page.getByTestId("story-empty")).toBeVisible();

  forgetHome(home);
});

test("a story is begun under a name and stood on at its first step", async ({
  page,
}) => {
  const home = await emptyProject(page, "Story Begun");
  await openStoryRoom(page);
  await newStory(page, "Rain at Night");

  // The room stands on the first of the five steps, and the steps the story
  // has not earned are closed, saying which one comes first.
  await expect(page.getByTestId("story-step-idea")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("story-step-body-idea")).toBeVisible();
  await expect(page.getByTestId("story-step-outline")).toBeDisabled();
  await expect(page.getByTestId("story-step-outline")).toHaveAttribute(
    "title",
    "Premise comes first",
  );
  await expect(page.locator(".story-head-name")).toHaveText("Rain at Night");

  // The step being stood on carries a fill of its own, and its name is read
  // over that fill rather than in the colour the pressed-button rule would
  // leave on it — a step whose words and ground are two darks is a step nobody
  // can read, and which step is open is worth knowing at a glance.
  expect(
    await contrastOf(page.getByTestId("story-step-idea")),
  ).toBeGreaterThanOrEqual(4.5);

  // The story is the document's, and reaches the server on the autosave alone.
  await expect
    .poll(async () => persistedStoryNames(page))
    .toEqual(["Rain at Night"]);

  // The story has a tab across the bar, the way every board and every cut has
  // one in the rooms beside this.
  await expect(page.locator(".story-bar-tab.is-active")).toHaveText(
    "Rain at Night",
  );

  // The machine remembers the story that was being told, across a reload.
  await page.reload();
  await openRecent(page, "Story Begun");
  await openStoryRoom(page);
  await expect(page.locator(".story-head-name")).toHaveText("Rain at Night");

  forgetHome(home);
});

test("a story is renamed in place, and the rename can be undone", async ({
  page,
}) => {
  const home = await emptyProject(page, "Story Renamed");
  await openStoryRoom(page);
  await newStory(page, "Rain at Night");

  await page.locator(".story-head-name").dblclick();
  const field = page.getByRole("textbox", { name: "Rename Rain at Night" });
  await field.fill("Night Train");
  await field.press("Enter");
  await expect(page.locator(".story-head-name")).toHaveText("Night Train");
  await expect(page.locator(".story-row-name")).toHaveText("Night Train");
  await expect(page.locator(".story-bar-tab.is-active")).toHaveText(
    "Night Train",
  );

  // The rename is a step in the history like any other change to the work.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".story-row-name")).toHaveText("Rain at Night");

  forgetHome(home);
});

test("a second story gets a tab, and the tab turns the room over", async ({
  page,
}) => {
  const home = await emptyProject(page, "Story Tabs");
  await openStoryRoom(page);
  await newStory(page, "Rain at Night");
  await newStory(page, "Snow at Dawn");

  // A new story is stood on when it is begun, and both are on the strip.
  await expect(page.locator(".story-head-name")).toHaveText("Snow at Dawn");
  await expect(page.locator(".story-bar-tab")).toHaveCount(2);

  await page.getByTestId("story-tab-Rain at Night").click();
  await expect(page.locator(".story-head-name")).toHaveText("Rain at Night");
  await expect(page.locator(".story-row.is-active .story-row-name")).toHaveText(
    "Rain at Night",
  );
  await expect(page.locator(".story-bar-tab.is-active")).toHaveText(
    "Rain at Night",
  );

  forgetHome(home);
});

test("a narrow window keeps the stage and folds the column away", async ({
  page,
}) => {
  const home = await emptyProject(page, "Story Narrow");
  await page.setViewportSize({ width: 1280, height: 800 });
  await openStoryRoom(page);
  await newStory(page, "Rain at Night");
  await expect(page.locator(".story-side")).toBeVisible();

  // The column beside the stage is the first thing to go when the window is
  // too narrow to hold both — the same 900px rule the other rooms obey.
  await page.setViewportSize({ width: 880, height: 800 });
  await expect(page.locator(".story-side")).toBeHidden();
  await expect(page.locator(".story-stage")).toBeVisible();
  await expect(page.getByTestId("story-step-idea")).toBeVisible();

  forgetHome(home);
});
