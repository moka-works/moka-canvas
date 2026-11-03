import { join } from "node:path";
import { expect, test, type Locator } from "./fixtures";
import { createProject, forgetProjects, projectHome } from "./helpers";

/** Where the words of a row start, which is what a column of names is read by. */
async function labelLeftOf(row: Locator): Promise<number> {
  const box = await row.locator(".tree-label").boundingBox();
  expect(box).not.toBeNull();
  return Math.round(box!.x);
}

test("the board being looked at is marked in its words, not in its place", async ({
  page,
}) => {
  const home = projectHome("tree-mark");

  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), "Tree Mark");

  // A second board, so two rows of the same kind can be read against one
  // another with one of them being the board the editor is looking at.
  await page
    .getByRole("button", { name: "New canvas at the top level" })
    .click();
  await expect(page.getByTestId("canvas-tab-Canvas 2")).toBeVisible();

  const rows = page.locator(".tree-root > .tree-item > .tree-row");
  await expect(rows).toHaveCount(2);
  const first = rows.nth(0);
  const second = rows.nth(1);

  // Every row wears the shape a row of the tree is given, the one being looked
  // at among them: a row that lost that shape lays its words out its own way
  // and starts them somewhere the other rows do not.
  await expect(first).toHaveClass(/tree-row/);
  await expect(second).toHaveClass(/tree-row/);
  await expect(first).toHaveCSS("display", "flex");
  await expect(second).toHaveCSS("display", "flex");
  expect(await labelLeftOf(first)).toBe(await labelLeftOf(second));

  // Which board is being looked at is said in heavier words, and in nothing
  // that moves the row: only one of them is the board, so only one is bold.
  await expect(page.locator(".tree-row.is-active")).toHaveCount(1);
  await expect(second).toHaveClass(/is-active/);
  await expect(second.locator(".tree-label")).toHaveCSS("font-weight", "600");
  await expect(first.locator(".tree-label")).toHaveCSS("font-weight", "400");

  // Opening the other board moves the heavier words to it and takes them off
  // the first, and neither row goes anywhere: the column of names still lines up.
  await first.locator(".tree-label").click();
  await expect(page.getByTestId("canvas-tab-Canvas 1")).toBeVisible();
  await expect(first).toHaveClass(/is-active/);
  await expect(second).not.toHaveClass(/is-active/);
  await expect(first.locator(".tree-label")).toHaveCSS("font-weight", "600");
  await expect(second.locator(".tree-label")).toHaveCSS("font-weight", "400");
  expect(await labelLeftOf(first)).toBe(await labelLeftOf(second));
});
