import { expect, test, type Page } from "./fixtures";
import {
  configureTheWholeStudio,
  forgetHome,
  forgetProjects,
  openSeededStory,
  projectHome,
} from "./helpers";

test.describe.configure({ timeout: 120_000 });

/** The first chapter's outline version, board version and shot words. */
async function persistedChapter(page: Page): Promise<{
  revision: number;
  boardRevision: number;
  contents: string[];
}> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        stories?: {
          chapters?: {
            revision?: number;
            boardRevision?: number;
            acts?: { keyframes?: { content?: string }[] }[];
          }[];
        }[];
      };
    };
    const chapter = body.moka?.stories?.[0]?.chapters?.[0] ?? {};
    const revision = chapter.revision ?? 1;
    return {
      revision,
      boardRevision: chapter.boardRevision ?? revision,
      contents: (chapter.acts ?? []).flatMap((act) =>
        (act.keyframes ?? []).map((keyframe) => keyframe.content ?? ""),
      ),
    };
  });
}

test("a revised outline updates one shot's words and keeps its picture", async ({
  page,
}) => {
  const home = projectHome("story-outline-revision");
  await forgetProjects();
  await configureTheWholeStudio();
  try {
    // The telling stands at a boarded episode whose frames are drawn: enough
    // for a revision to have a picture to disagree with.
    await openSeededStory(page, home);

    // The outline moves on after the board and its first act's pictures exist.
    await page.getByTestId("story-step-outline").click();
    await page.getByTestId("story-chapter-edit-0").click();
    await page
      .getByTestId("story-chapter-synopsis-0")
      .fill(
        "The lamp goes out; the platform is dark and the train never comes.",
      );
    await page.getByTestId("story-chapter-confirm-0").click();
    await expect(page.getByTestId("story-chapter-version-0")).toContainText(
      "board on v1",
    );

    // The board says it is behind, and offers the two ways to follow.
    await page.getByTestId("story-step-storyboard").click();
    await expect(page.getByTestId("story-board-outline-ahead")).toContainText(
      "v2",
    );
    await page.getByTestId("story-board-outline-update").click();
    await expect(page.getByTestId("story-outline-sync")).toBeVisible();
    await page.getByTestId("story-outline-sync-start").click();

    // The revision is a proposal until the reader applies it.
    await expect(page.getByTestId("story-board-revision-pending")).toBeVisible({
      timeout: 60_000,
    });
    await page.getByTestId("story-board-revision-review").click();
    await expect(page.getByTestId("story-board-revision-dialog")).toBeVisible();
    await expect(page.getByTestId("story-board-revision-apply")).toContainText(
      "v2",
    );
    await page.getByTestId("story-board-revision-apply").click();

    // The words are new, the version is in step, and the old picture is still
    // there with the board saying it was made from the old words.
    await expect(page.getByTestId("story-board-outline-ahead")).toHaveCount(0);
    await expect(
      page.locator('[data-testid^="story-frame-prompt-drift-"]').first(),
    ).toBeVisible();
    await expect(page.getByTestId("story-board-redraw-drifted")).toBeVisible();
    await expect
      .poll(async () => (await persistedChapter(page)).revision)
      .toBe(2);
    await expect
      .poll(async () => (await persistedChapter(page)).boardRevision)
      .toBe(2);
    await expect
      .poll(async () => (await persistedChapter(page)).contents[0] ?? "")
      .toContain("Rain over the dark platform");
  } finally {
    forgetHome(home);
  }
});
