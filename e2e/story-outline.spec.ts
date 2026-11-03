import { join } from "node:path";
import { expect, test, type Page } from "./fixtures";
import {
  configureTextModel,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openStoryRoom,
  projectHome,
} from "./helpers";
import { STORYTELLER } from "./mock-provider";

/**
 * The second step: a premise written into the episodes it is told in.
 *
 * The telling asks a model for a chapter table and is answered in that shape;
 * what the suite follows is everything around it — the count the reader chose,
 * the batch the room starts, the chapters that land in the story, and the step
 * that is opened by confirming them.
 */

/** The titles of the first story's chapters, as the server has them written. */
async function persistedChapterTitles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: { stories?: { chapters?: { title?: string }[] }[] };
    };
    return (body.moka?.stories?.[0]?.chapters ?? []).map(
      (chapter) => chapter.title ?? "",
    );
  });
}

test("a premise becomes the chapters the reader counted", async ({ page }) => {
  const home = projectHome("story-outline");
  await forgetProjects();
  await configureTextModel(STORYTELLER);
  try {
    await page.goto("/");
    await createProject(page, join(home, "project"), "Story Outline");
    await openStoryRoom(page);
    await newStory(page, "Rain at Night");

    // The premise first: the outline is not a door until there is one.
    await expect(page.getByTestId("story-step-outline")).toBeDisabled();
    await page
      .getByTestId("story-idea-input")
      .fill("Eleven at night, and the last train stops where it should not.");
    await page.getByTestId("story-idea-tab-upload").click();
    await page.getByTestId("story-idea-tab-write").click();
    await page.getByTestId("story-idea-duration-3").click();
    await page.getByTestId("story-confirm-idea").click();

    await expect(page.getByTestId("story-step-body-outline")).toBeVisible();
    await expect(page.getByTestId("story-outline-chapters")).toHaveValue("3");
    await expect(page.getByTestId("story-outline-will-ask")).toHaveText(
      "Asks for 3 chapters",
    );

    await page.getByTestId("story-outline-start").click();

    // Three episodes come back and are written into the story.
    await expect(page.locator(".story-chapter")).toHaveCount(3, {
      timeout: 30_000,
    });
    await expect(page.getByTestId("story-chapter-title-0")).toHaveValue(
      "Chapter 1",
    );

    // Nothing of the outline is agreed to chapter by chapter: the step's own
    // press reads the whole of it, and that is what opens step three.
    await expect(page.getByTestId("story-step-elements")).toBeDisabled();
    await page.getByTestId("story-confirm-outline").click();
    await expect(page.getByTestId("story-step-elements")).toBeEnabled();

    // The chapters are the document's, and reach the server on the autosave.
    await expect
      .poll(async () => persistedChapterTitles(page))
      .toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);
  } finally {
    forgetHome(home);
  }
});
