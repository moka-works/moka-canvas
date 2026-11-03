import { join } from "node:path";
import { expect, test, type Locator, type Page } from "./fixtures";
import {
  backToLauncher,
  createProject,
  forgetProjects,
  projectHome,
} from "./helpers";

const LONG_NAME =
  "An autumn campaign teaser whose project name rambles on far past what any bar can hold";

/** The page owns its width: nothing on it may widen it past the window. */
async function pageFitsWindow(page: Page) {
  return page.evaluate(() => {
    const Browser = globalThis as unknown as {
      document: { documentElement: { scrollWidth: number } };
      innerWidth: number;
    };
    return Browser.document.documentElement.scrollWidth <= Browser.innerWidth;
  });
}

/** Whether the text in the box is wider than the room the box stands in. */
async function clipped(locator: Locator) {
  return locator.evaluate((el) => {
    const box = el as unknown as { scrollWidth: number; clientWidth: number };
    return box.scrollWidth > box.clientWidth;
  });
}

test("a long project name truncates in the launcher and the top bar", async ({
  page,
}) => {
  const home = projectHome("long-name");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "projects"), LONG_NAME);

  // The bar holds the name to its share of the row, keeping the tabs beside
  // it, and carries the whole of the name on the tooltip.
  const barName = page.getByRole("banner").locator(".editor-project-name");
  await expect(barName).toHaveAttribute("title", LONG_NAME);
  expect(await clipped(barName)).toBe(true);
  await expect(page.getByTestId("canvas-tab-Canvas 1")).toBeVisible();
  expect(await pageFitsWindow(page)).toBe(true);

  // The launcher's row does the same for the name and for the path, each
  // carrying the whole of its text on the tooltip.
  await backToLauncher(page);
  const row = page
    .locator("button.launcher-recent")
    .filter({ hasText: LONG_NAME });
  const rowName = row.locator("strong");
  const rowPath = row.locator("span");
  await expect(rowName).toHaveAttribute("title", LONG_NAME);
  await expect(rowPath).toHaveAttribute("title", /.+\/.+/);
  expect(await clipped(rowName)).toBe(true);
  expect(await clipped(rowPath)).toBe(true);
  expect(await pageFitsWindow(page)).toBe(true);
});
