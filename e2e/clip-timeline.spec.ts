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
 * The timeline draws itself, and answers about what it is showing.
 *
 * The picture is pixels and cannot be read back, so the canvas's neighbours
 * and its data attributes carry the assertions: the scale, the playhead, and
 * where the view is scrolled to. No clips are needed — the rows, the ruler
 * and the content floor are already there on an empty cut.
 */

async function clippedProject(page: Page) {
  const home = projectHome("clip-timeline");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), "Timeline Room");
  await openClipRoom(page);
  return home;
}

function timeline(page: Page) {
  return page.locator(".clip-timeline");
}

async function readPlayhead(page: Page): Promise<number> {
  return Number(await timeline(page).getAttribute("data-playhead-ms"));
}

test("the cut draws a ruler over a canvas, and the view group zooms it", async ({
  page,
}) => {
  const home = await clippedProject(page);
  await newTimeline(page, "Timeline 1");

  await expect(timeline(page)).toHaveAttribute("data-px-per-sec", "60");
  await expect(page.locator(".clip-tl-canvas")).toBeVisible();
  // Three rows, top-down from the last track: Text 1 over Audio 1 over Video 1.
  const rows = page.locator(".clip-tl-header-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Text 1");
  await expect(rows.nth(2)).toContainText("Video 1");

  const zoomIn = page.getByTestId("clip-zoom-in");
  const zoomOut = page.getByTestId("clip-zoom-out");
  await zoomIn.click();
  await expect(timeline(page)).toHaveAttribute("data-px-per-sec", "90");
  await zoomOut.click();
  await expect(timeline(page)).toHaveAttribute("data-px-per-sec", "60");

  // The buttons stop at the room's own limits, and say so by going quiet.
  for (let i = 0; i < 20 && !(await zoomIn.isDisabled()); i += 1) {
    await zoomIn.click();
  }
  await expect(timeline(page)).toHaveAttribute("data-px-per-sec", "960");
  await expect(zoomIn).toBeDisabled();

  for (let i = 0; i < 20 && !(await zoomOut.isDisabled()); i += 1) {
    await zoomOut.click();
  }
  await expect(timeline(page)).toHaveAttribute("data-px-per-sec", "4");
  await expect(zoomOut).toBeDisabled();

  // Fit brings the whole cut back onto the screen, somewhere in between.
  await page.getByTestId("clip-zoom-fit").click();
  const fitted = Number(await timeline(page).getAttribute("data-px-per-sec"));
  expect(fitted).toBeGreaterThan(4);
  expect(fitted).toBeLessThan(60);
  await expect(zoomOut).toBeEnabled();

  forgetHome(home);
});

test("the ruler places the playhead, and the wheel moves the view under it", async ({
  page,
}) => {
  const home = await clippedProject(page);
  await newTimeline(page, "Timeline 1");

  const canvas = page.locator(".clip-tl-canvas");
  // A locator click waits for the element to hold still, where a raw mouse
  // click would race the layout the room is still settling into.
  await canvas.click({ position: { x: 300, y: 10 } });

  // 300px at 60px/s is five seconds, give or take the frame the pointer lands on.
  await expect.poll(() => readPlayhead(page)).toBeGreaterThan(0);
  expect(Math.abs((await readPlayhead(page)) - 5_000)).toBeLessThanOrEqual(
    1_000 / 30 + 1,
  );

  // A drag on the ruler carries the playhead along with it.
  const box = (await canvas.boundingBox())!;
  await canvas.hover({ position: { x: 300, y: 10 } });
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 10, { steps: 4 });
  await page.mouse.up();
  const dragged = await readPlayhead(page);
  expect(dragged).toBeGreaterThan(6_000);

  // The viewport is the only scroller, and a plain wheel is looking rather
  // than seeking: the playhead keeps its place while the content moves.
  const viewport = page.locator(".clip-tl-viewport");
  await viewport.hover();
  await page.mouse.wheel(400, 0);
  await expect
    .poll(() =>
      // The browser-side element is typed structurally: this tsconfig has no DOM lib.
      viewport.evaluate(
        (element) => (element as { scrollLeft: number }).scrollLeft,
      ),
    )
    .toBeGreaterThan(0);
  await expect(timeline(page)).toHaveAttribute(
    "data-playhead-ms",
    String(dragged),
  );

  // A wheel held under Ctrl is a zoom about the pointer, not a scroll.
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect
    .poll(async () =>
      Number(await timeline(page).getAttribute("data-px-per-sec")),
    )
    .toBeGreaterThan(60);

  forgetHome(home);
});

test("each timeline keeps its own view, and the machine keeps them across a reload", async ({
  page,
}) => {
  const home = await clippedProject(page);
  await newTimeline(page, "Timeline 1");
  await newTimeline(page, "Timeline 2");
  const strip = page.getByRole("tablist", { name: "Timelines" });

  await strip.getByRole("tab", { name: "Timeline 1" }).click();
  await page.getByTestId("clip-zoom-in").click();
  await expect(timeline(page)).toHaveAttribute("data-px-per-sec", "90");

  // A timeline nobody has zoomed opens where a cut starts.
  await strip.getByRole("tab", { name: "Timeline 2" }).click();
  await expect(timeline(page)).toHaveAttribute("data-px-per-sec", "60");
  await page.getByTestId("clip-zoom-out").click();
  await expect(timeline(page)).toHaveAttribute("data-px-per-sec", "40");

  // Stepping back onto the first hands the reader the scale they left it at.
  await strip.getByRole("tab", { name: "Timeline 1" }).click();
  await expect(timeline(page)).toHaveAttribute("data-px-per-sec", "90");

  // The remembering is the machine's, so a reload opens onto it again — but
  // the cut itself is saved a beat after the clicks, and the reload must go
  // looking for a document that already holds both timelines.
  await expect
    .poll(() => persistedTimelineNames(page))
    .toEqual(["Timeline 1", "Timeline 2"]);
  await page.reload();
  await openRecent(page, "Timeline Room");
  await openClipRoom(page);
  await expect(timeline(page)).toHaveAttribute("data-px-per-sec", "90");
  await expect(strip.getByRole("tab", { name: "Timeline 1" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  forgetHome(home);
});
