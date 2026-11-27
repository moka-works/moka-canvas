import { expect, test, type Page } from "./fixtures";
import {
  configureTheWholeStudio,
  forgetHome,
  forgetProjects,
  openSeededStory,
  projectHome,
} from "./helpers";

test.describe.configure({ timeout: 90_000 });

/** How far one act's head stands below the top of the step's window. */
function headOffset(page: Page, at: number): Promise<number> {
  return page.evaluate((index) => {
    const scroller = document.querySelector<HTMLElement>(".story-step-body");
    const rows = document.querySelectorAll<HTMLElement>(
      ".story-acts > li.story-act",
    );
    const row = rows[index];
    if (scroller === null || row === undefined) {
      return Number.POSITIVE_INFINITY;
    }
    return (
      row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    );
  }, at);
}

test("jumps to any act of a long board, and keeps its footing when acts fold", async ({
  page,
}) => {
  const home = projectHome("story-act-nav");
  await forgetProjects();
  await configureTheWholeStudio();
  try {
    await openSeededStory(page, home, false);
    await page.getByTestId("story-step-storyboard").click();
    await expect(page.getByTestId("story-act-0")).toBeVisible({
      timeout: 60_000,
    });

    // The seeded first episode is shorter than the rail is worth; acts are
    // added at the seam under the last one until the board is long.
    const cards = page.locator(".story-acts > li.story-act");
    while ((await cards.count()) < 5) {
      const before = await cards.count();
      await page.locator(".story-acts .story-insert button").last().click();
      await expect(cards).toHaveCount(before + 1);
    }
    await expect(cards).toHaveCount(5);

    const nav = page.getByTestId("story-act-nav");
    await expect(nav).toBeVisible();
    await expect(nav.locator("button")).toHaveCount(5);

    // A press on the last number puts the last act's head at the top of the
    // window, and says that is the act now being read.
    await page.getByTestId("story-act-nav-4").click();
    await expect(page.getByTestId("story-act-nav-4")).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect
      .poll(() => headOffset(page, 4), { timeout: 10_000 })
      .toBeLessThan(60);
    await expect.poll(() => headOffset(page, 4)).toBeGreaterThanOrEqual(0);

    // Folding the acts above changes the height of the board and moves every
    // act under them: the rail measures the page again rather than trusting
    // the places those acts had before they were folded.
    await page.getByTestId("story-act-nav-0").click();
    await page.getByTestId("story-act-fold-0").click();
    await page.getByTestId("story-act-fold-1").click();
    await page.getByTestId("story-act-nav-3").click();
    await expect(page.getByTestId("story-act-nav-3")).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect
      .poll(() => headOffset(page, 3), { timeout: 10_000 })
      .toBeLessThan(60);
    // A place remembered from before the fold would overshoot and put the head
    // above the window; the act has to be at the top, not somewhere past it.
    await expect.poll(() => headOffset(page, 3)).toBeGreaterThanOrEqual(0);

    // Scrolling back by hand brings the mark back to the act at the top, which
    // is now a folded one.
    await page.getByTestId("story-step-body-storyboard").evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(page.getByTestId("story-act-nav-0")).toHaveAttribute(
      "aria-current",
      "true",
    );
  } finally {
    forgetHome(home);
  }
});
