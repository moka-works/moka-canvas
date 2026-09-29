import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createProject,
  forgetHome,
  forgetProjects,
  newTimeline,
  openClipRoom,
  openRecent,
  persistedTimelineNames,
  projectHome,
} from "./helpers";

/**
 * The cutting room stands on its own feet.
 *
 * A project with no timeline opens onto the first-run question, timelines are
 * added, switched, renamed and taken away through the strip, and the corner
 * menu walks between the two working pages without putting the project down:
 * what the room holds is in the document, and what it remembers is on the
 * machine, and both survive a reload in their own way.
 */

async function clippedProject(page: Page) {
  const home = projectHome("clip-room");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), "Cutting Room");
  await openClipRoom(page);
  return home;
}

/** The strip of timelines, apart from the rail of faces beside the stage. */
function strip(page: Page) {
  return page.getByRole("tablist", { name: "Timelines" });
}

// A tiny valid PNG (1x1 transparent pixel), as the other specs use.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test("a project without timelines opens onto the first-run question", async ({
  page,
}) => {
  const home = await clippedProject(page);

  await expect(page.getByText("No timelines yet")).toBeVisible();
  await expect(
    page.getByText("Create a timeline to start cutting"),
  ).toBeVisible();
  await expect(strip(page).getByRole("tab")).toHaveCount(0);

  await newTimeline(page, "Timeline 1");

  // The tab that arrives is the one being looked at, and the first-run
  // question has given way to the empty cut it stood in for.
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 1" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("No timelines yet")).toHaveCount(0);
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  // The preview stands on the empty cut: the frame the playhead will be read
  // against, and the timecode at the head it has not moved off yet.
  await expect(page.locator("canvas.clip-preview-canvas")).toBeVisible();
  await expect(page.getByTestId("preview-timecode")).toHaveText("00:00:00:00");

  forgetHome(home);
});

test("a second timeline joins the strip, and the machine remembers the one being read", async ({
  page,
}) => {
  const home = await clippedProject(page);
  await newTimeline(page, "Timeline 1");
  await newTimeline(page, "Timeline 2");

  await expect(strip(page).getByRole("tab")).toHaveCount(2);
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 2" }),
  ).toHaveAttribute("aria-selected", "true");

  // Switching turns the strip over without touching the document.
  await strip(page).getByRole("tab", { name: "Timeline 1" }).click();
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 1" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 2" }),
  ).toHaveAttribute("aria-selected", "false");

  // A double-click renames the tab in place, and Enter takes the words.
  await strip(page).getByRole("tab", { name: "Timeline 2" }).dblclick();
  const field = page.getByRole("textbox", { name: "Rename Timeline 2" });
  await field.fill("Second cut");
  await field.press("Enter");
  await expect(
    strip(page).getByRole("tab", { name: "Second cut" }),
  ).toHaveAttribute("aria-selected", "true");

  // The rename is the timeline being looked at, and it is written down before
  // the page is read again.
  await expect
    .poll(async () => persistedTimelineNames(page))
    .toContain("Second cut");

  await page.reload();
  await openRecent(page, "Cutting Room");
  await openClipRoom(page);

  // The project opens onto the timeline this machine was left on.
  await expect(
    strip(page).getByRole("tab", { name: "Second cut" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 1" }),
  ).toHaveAttribute("aria-selected", "false");

  forgetHome(home);
});

test("a timeline is taken off the strip, and the room asks again when none is left", async ({
  page,
}) => {
  const home = await clippedProject(page);
  await newTimeline(page, "Timeline 1");
  await newTimeline(page, "Timeline 2");

  // An empty timeline is a tab and nothing else: one click takes it away, and
  // the timeline beside it takes the view.
  await page.getByRole("button", { name: "Delete Timeline 2" }).click();
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 2" }),
  ).toHaveCount(0);
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 1" }),
  ).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "Delete Timeline 1" }).click();
  await expect(strip(page).getByRole("tab")).toHaveCount(0);
  await expect(page.getByText("No timelines yet")).toBeVisible();

  forgetHome(home);
});

test("a timeline holding work is deleted only after a question that stands inside the window", async ({
  page,
}) => {
  const home = await clippedProject(page);
  await newTimeline(page, "Timeline 1");

  // A timeline with something on it asks first, where the empty one above goes
  // in a single click. The clip goes on through the shelf's own button, since
  // only the question that follows is what this test reads.
  await page.getByLabel("Import files", { exact: true }).setInputFiles({
    name: "one.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
  await page
    .getByRole("button", { name: "Add one.png at the playhead" })
    .click();
  await expect(page.locator(".clip-timeline")).toHaveAttribute(
    "data-clip-count",
    "1",
  );

  await page.getByRole("button", { name: "Delete Timeline 1" }).click();
  const asked = page.getByRole("alertdialog", { name: "Delete timeline?" });
  await expect(asked).toBeVisible({ timeout: 10_000 });

  // The question covers the window and stands in the middle of it. An element
  // that blurs what is behind it is the box its fixed children are laid out
  // in, so a question rendered from the blurred bar the strip stands on used
  // to be centred on the bar instead — hanging off the top of the window.
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const backdrop = await page.locator(".dialog-backdrop").boundingBox();
  const box = await asked.boundingBox();
  expect(backdrop).not.toBeNull();
  expect(box).not.toBeNull();
  expect(backdrop!.y).toBe(0);
  expect(backdrop!.height).toBe(viewport!.height);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  expect(Math.abs(box!.y - (viewport!.height - box!.height) / 2)).toBeLessThan(
    2,
  );

  // Cancel leaves it alone; answering takes the whole timeline away.
  await asked.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(asked).toHaveCount(0);
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 1" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Delete Timeline 1" }).click();
  await expect(asked).toBeVisible({ timeout: 10_000 });
  await asked
    .getByRole("button", { name: "Delete timeline", exact: true })
    .click();
  await expect(strip(page).getByRole("tab")).toHaveCount(0);
  await expect(page.getByText("No timelines yet")).toBeVisible();

  forgetHome(home);
});

test("a recent project opens straight into the room its row was asked for", async ({
  page,
}) => {
  const home = await clippedProject(page);
  await newTimeline(page, "Timeline 1");
  await expect
    .poll(async () => persistedTimelineNames(page))
    .toEqual(["Timeline 1"]);

  // The launcher's row asks which room the project is for before it is put
  // on, so the cutting room is reached without the board being stood on and
  // left behind on the way.
  await page.reload();
  await openRecent(page, "Cutting Room", "Clip");
  await expect(page.getByTestId("clip-page")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("canvas-host")).toHaveCount(0);
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 1" }),
  ).toHaveAttribute("aria-selected", "true");

  forgetHome(home);
});

test("the corner menu marks the cutting room, and the board is one step beside it", async ({
  page,
}) => {
  const home = await clippedProject(page);
  await newTimeline(page, "Timeline 1");

  await page.getByRole("button", { name: "Projects menu" }).click();
  const menu = page.getByTestId("home-menu");
  await expect(menu.getByRole("menuitem", { name: "Clip" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    menu.getByRole("menuitem", { name: "Canvas" }),
  ).not.toHaveAttribute("aria-current", "page");

  await menu.getByRole("menuitem", { name: "Canvas" }).click();
  await expect(page.getByTestId("canvas-host")).toBeVisible({
    timeout: 10_000,
  });

  // Back through the same menu: the project was never put down, and the cut
  // that was made here is still in it.
  await openClipRoom(page);
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 1" }),
  ).toBeVisible();
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 1" }),
  ).toHaveAttribute("aria-selected", "true");

  forgetHome(home);
});

test("a new timeline reaches the project on its own, and the badge says so", async ({
  page,
}) => {
  const home = await clippedProject(page);
  await newTimeline(page, "Timeline 1");

  // The autosave debounce carries the command to the server without a Save
  // button being anywhere, and the badge settles on the word for it.
  await expect
    .poll(async () => persistedTimelineNames(page))
    .toEqual(["Timeline 1"]);
  await expect(page.locator(".save-status")).toHaveText("Saved", {
    timeout: 10_000,
  });

  forgetHome(home);
});
