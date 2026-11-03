import { join } from "node:path";
import { expect, test, type Locator, type Page } from "./fixtures";
import {
  createProject,
  forgetProjects,
  openRecent,
  projectHome,
} from "./helpers";

/** How wide a column is on screen, in whole pixels. */
async function widthOf(column: Locator): Promise<number> {
  const box = await column.boundingBox();
  expect(box).not.toBeNull();
  return Math.round(box!.width);
}

/** Drag the edge a column is dragged by, from where it is to where it is asked. */
async function dragEdge(page: Page, side: "left" | "right", by: number) {
  const edge = page.getByTestId(`panel-resizer-${side}`);
  const box = await edge.boundingBox();
  expect(box).not.toBeNull();
  const from = {
    x: box!.x + box!.width / 2,
    y: box!.y + box!.height / 2,
  };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by, from.y, { steps: 6 });
  await page.mouse.up();
}

test("both columns beside the canvas are dragged to a width, and keep it", async ({
  page,
}) => {
  const home = projectHome("panel-widths");

  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), "Panel Widths");

  const left = page.locator(".editor-side");
  const right = page.locator(".editor-inspector");
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();

  const leftStart = await widthOf(left);
  const rightStart = await widthOf(right);

  // The left column grows to the right and the right one grows to the left,
  // each by the travel of the pointer that dragged it.
  await dragEdge(page, "left", 100);
  expect(await widthOf(left)).toBe(leftStart + 100);

  await dragEdge(page, "right", -80);
  expect(await widthOf(right)).toBe(rightStart + 80);

  // The canvas beside them is what the two columns took their room from.
  const canvas = page.getByTestId("canvas-host");
  expect(await widthOf(canvas)).toBeGreaterThan(200);

  // A width somebody asked for is a width the editor opens with next time.
  const dragged = await widthOf(left);
  await page.reload();
  await openRecent(page, "Panel Widths");
  await expect(left).toBeVisible({ timeout: 10_000 });
  expect(await widthOf(left)).toBe(dragged);

  // A double-click hands the column back to the width its stylesheet gives it.
  await page.getByTestId("panel-resizer-left").dblclick();
  expect(await widthOf(left)).toBe(leftStart);
});

test("a column is dragged by the arrow keys as well as by the pointer", async ({
  page,
}) => {
  const home = projectHome("panel-keys");

  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), "Panel Keys");

  const edge = page.getByTestId("panel-resizer-left");
  const left = page.locator(".editor-side");
  const start = await widthOf(left);

  await edge.focus();
  await expect(edge).toHaveAttribute("aria-valuenow", String(start));

  await page.keyboard.press("ArrowRight");
  await expect(edge).toHaveAttribute("aria-valuenow", String(start + 8));
  expect(await widthOf(left)).toBe(start + 8);

  await page.keyboard.press("Shift+ArrowLeft");
  await expect(edge).toHaveAttribute("aria-valuenow", String(start - 40));
  expect(await widthOf(left)).toBe(start - 40);
});
