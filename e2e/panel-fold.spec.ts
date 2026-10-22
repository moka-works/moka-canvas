import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createProject,
  forgetHome,
  forgetProjects,
  openAssetsRoom,
  openClipRoom,
  openRecent,
  projectHome,
} from "./helpers";

/** The corner a mark stands in, rounded to whole pixels of the window. */
async function cornerOf(mark: Locator) {
  const box = await mark.boundingBox();
  expect(box).not.toBeNull();
  return {
    x: Math.round(box!.x),
    y: Math.round(box!.y),
    right: Math.round(box!.x + box!.width),
  };
}

/**
 * Whether the window answers a click at a point of a mark's square: the half
 * triangle fills one top corner of it, and the half cut away is not there to
 * be answered. The points told apart are the two sides of that diagonal.
 */
async function filledHalf(page: Page, mark: Locator, side: "left" | "right") {
  const box = await mark.boundingBox();
  expect(box).not.toBeNull();
  const testid = await mark.getAttribute("data-testid");
  expect(testid).not.toBeNull();
  return page.evaluate(
    ({ x, y, testid }) => {
      const Browser = globalThis as unknown as {
        document: {
          elementFromPoint(
            x: number,
            y: number,
          ): {
            closest(selector: string): unknown;
          } | null;
        };
      };
      const hit = Browser.document.elementFromPoint(x, y);
      return !!hit?.closest(`[data-testid="${testid}"]`);
    },
    {
      x: box!.x + (side === "left" ? 5 : 19),
      y: box!.y + 10,
      testid: testid!,
    },
  );
}

async function widthOf(column: Locator): Promise<number> {
  const box = await column.boundingBox();
  return box ? Math.round(box.width) : 0;
}

test("both columns fold away from a corner and come back to it", async ({
  page,
}) => {
  const home = projectHome("panel-fold");

  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), "Panel Fold");

  const canvas = page.getByTestId("canvas-host");
  const left = page.locator(".editor-side");
  const right = page.locator(".editor-right");
  const foldLeft = page.getByTestId("panel-fold-left");
  const foldRight = page.getByTestId("panel-fold-right");

  // Each column carries its fold in the corner it keeps beside the canvas —
  // the left one at the right edge of its column, the right one at the left
  // edge of its own — cut from that corner and not the other. The hairline
  // each column wears against the canvas is the column's own edge, so the
  // fold stands just inside it.
  await expect(foldLeft).toBeVisible();
  await expect(foldRight).toBeVisible();
  const leftPanel = await left.boundingBox();
  const leftFold = await cornerOf(foldLeft);
  expect(leftFold.y).toBe(Math.round(leftPanel!.y));
  expect(leftFold.right).toBe(Math.round(leftPanel!.x + leftPanel!.width) - 1);
  expect(await filledHalf(page, foldLeft, "right")).toBe(true);
  expect(await filledHalf(page, foldLeft, "left")).toBe(false);
  const rightPanel = await right.boundingBox();
  const rightFold = await cornerOf(foldRight);
  expect(rightFold.y).toBe(Math.round(rightPanel!.y));
  expect(rightFold.x).toBe(Math.round(rightPanel!.x) + 1);
  expect(await filledHalf(page, foldRight, "left")).toBe(true);
  expect(await filledHalf(page, foldRight, "right")).toBe(false);

  // The fold stands clear of the tabs beside it, which still answer to a click.
  await page.getByTestId("left-tab-assets").click();
  await expect(page.getByTestId("left-tab-assets")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByTestId("left-tab-project").click();
  await expect(page.getByTestId("left-tab-project")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  const canvasBefore = await widthOf(canvas);

  // Folding a column away hands its room to the canvas and leaves the corner
  // it stood in offering the way back — the edge it was dragged by goes too,
  // since there is no longer a column there to drag.
  await foldLeft.click();
  await expect(left).toHaveCount(0);
  await expect(page.getByTestId("panel-resizer-left")).toHaveCount(0);
  await expect(foldLeft).toHaveCount(0);
  const unfoldLeft = page.getByTestId("panel-unfold-left");
  await expect(unfoldLeft).toBeVisible();
  const corner = await cornerOf(unfoldLeft);
  expect(corner.x).toBe(0);
  expect(corner.y).toBe(Math.round(leftPanel!.y));
  // Its triangle fills the window corner it stands in, the straight edges
  // along the window's own.
  expect(await filledHalf(page, unfoldLeft, "left")).toBe(true);
  expect(await filledHalf(page, unfoldLeft, "right")).toBe(false);
  expect(await widthOf(canvas)).toBe(
    canvasBefore + Math.round(leftPanel!.width),
  );
  // The column on the other side was not asked about, so it still stands.
  await expect(right).toBeVisible();

  // The corner brings the column back, and its dragged edge comes with it.
  await unfoldLeft.click();
  await expect(left).toBeVisible();
  await expect(page.getByTestId("panel-resizer-left")).toBeVisible();
  await expect(foldLeft).toBeVisible();
  await expect(unfoldLeft).toHaveCount(0);

  // The column on the other side folds the same way round, into its own corner.
  await foldRight.click();
  await expect(right).toHaveCount(0);
  await expect(page.getByTestId("panel-resizer-right")).toHaveCount(0);
  const unfoldRight = page.getByTestId("panel-unfold-right");
  await expect(unfoldRight).toBeVisible();
  const body = await page.locator(".editor-body").boundingBox();
  expect((await cornerOf(unfoldRight)).right).toBe(
    Math.round(body!.x + body!.width),
  );
  expect(await filledHalf(page, unfoldRight, "right")).toBe(true);
  expect(await filledHalf(page, unfoldRight, "left")).toBe(false);

  // With both columns away the canvas has the whole row to itself.
  await foldLeft.click();
  await expect(left).toHaveCount(0);
  expect(await widthOf(canvas)).toBe(Math.round(body!.width));

  // What was folded away is remembered on this machine, so the editor opens
  // the same way round rather than asking for the columns again.
  await page.reload();
  await openRecent(page, "Panel Fold");
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  await expect(left).toHaveCount(0);
  await expect(right).toHaveCount(0);
  await expect(page.getByTestId("panel-unfold-left")).toBeVisible();
  await expect(page.getByTestId("panel-unfold-right")).toBeVisible();

  // And one click on a corner stands the column back up.
  await page.getByTestId("panel-unfold-left").click();
  await expect(left).toBeVisible();
  await expect(page.getByTestId("panel-fold-left")).toBeVisible();
});

test("the cutting room folds its columns beside its rail", async ({ page }) => {
  const home = projectHome("panel-fold-clip");

  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), "Folded Cut");
  await openClipRoom(page);

  // The column the rail turns over carries its fold in the corner it keeps
  // beside the stage, cut from that corner, just inside its own hairline.
  const foldLeft = page.getByTestId("panel-fold-left");
  await expect(foldLeft).toBeVisible();
  const column = await page.locator(".clip-column").boundingBox();
  const fold = await cornerOf(foldLeft);
  expect(fold.y).toBe(Math.round(column!.y));
  expect(fold.right).toBe(Math.round(column!.x + column!.width) - 1);
  expect(await filledHalf(page, foldLeft, "right")).toBe(true);
  expect(await filledHalf(page, foldLeft, "left")).toBe(false);

  // The inspector on the other side of the stage folds the same way round.
  const foldRight = page.getByTestId("panel-fold-right");
  await expect(foldRight).toBeVisible();
  const inspector = await page.locator(".clip-inspector").boundingBox();
  const right = await cornerOf(foldRight);
  expect(right.y).toBe(Math.round(inspector!.y));
  expect(right.x).toBe(Math.round(inspector!.x) + 1);
  expect(await filledHalf(page, foldRight, "left")).toBe(true);
  expect(await filledHalf(page, foldRight, "right")).toBe(false);

  // Folding the column away leaves the way back at the rail's right edge,
  // where the column stood, rather than over the faces the rail carries.
  await foldLeft.click();
  const unfoldLeft = page.getByTestId("panel-unfold-left");
  await expect(unfoldLeft).toBeVisible();
  const rail = await page.locator(".clip-rail").boundingBox();
  const back = await cornerOf(unfoldLeft);
  expect(back.x).toBe(Math.round(rail!.x + rail!.width));
  expect(back.y).toBe(Math.round(rail!.y));
  expect(await filledHalf(page, unfoldLeft, "left")).toBe(true);
  expect(await filledHalf(page, unfoldLeft, "right")).toBe(false);

  // And the click there stands the column up again.
  await unfoldLeft.click();
  await expect(page.locator(".clip-column")).toBeVisible();
  await expect(page.getByTestId("panel-fold-left")).toBeVisible();
});

test("the shelf folds each column from its own corner", async ({ page }) => {
  const home = projectHome("panel-fold-assets");

  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), "Shelf Fold");
  await openAssetsRoom(page);

  const column = page.locator(".assets-column");
  const inspector = page.locator(".assets-inspector");
  const foldLeft = page.getByTestId("panel-fold-left");
  const foldRight = page.getByTestId("panel-fold-right");

  // Each triangle stands in the corner its own column keeps beside the stage:
  // the library's at its right edge, the inspector's at its left edge.
  const library = await column.boundingBox();
  const shelf = await inspector.boundingBox();
  const left = await cornerOf(foldLeft);
  const right = await cornerOf(foldRight);
  expect(left.y).toBe(Math.round(library!.y));
  expect(left.right).toBe(Math.round(library!.x + library!.width) - 1);
  expect(right.y).toBe(Math.round(shelf!.y));
  expect(right.x).toBe(Math.round(shelf!.x) + 1);

  // Each folds only its own column; the other one still stands.
  await foldLeft.click();
  await expect(column).toHaveCount(0);
  await expect(inspector).toBeVisible();
  await page.getByTestId("panel-unfold-left").click();
  await expect(column).toBeVisible();
  await expect(foldRight).toBeVisible();
  await foldRight.click();
  await expect(inspector).toHaveCount(0);
  await expect(column).toBeVisible();
  await page.getByTestId("panel-unfold-right").click();
  await expect(inspector).toBeVisible();

  forgetHome(home);
});
