import { expect, test, type Page } from "./fixtures";
import {
  configureTheWholeStudio,
  forgetHome,
  forgetProjects,
  openSeededStory,
  projectHome,
} from "./helpers";

test.describe.configure({ timeout: 90_000 });

/** What the server holds of the first chapter's shots. */
async function persistedContents(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        stories?: {
          chapters?: {
            acts?: { keyframes?: { content?: string }[] }[];
          }[];
        }[];
      };
    };
    return (body.moka?.stories?.[0]?.chapters?.[0]?.acts ?? []).flatMap((act) =>
      (act.keyframes ?? []).map((keyframe) => keyframe.content ?? ""),
    );
  });
}

test("a staging check patches a boarded episode's shots", async ({ page }) => {
  const home = projectHome("story-continuity");
  await forgetProjects();
  await configureTheWholeStudio();
  try {
    // A telling whose board already stands: the check is about the shots on
    // file, not about writing the board again.
    await openSeededStory(page, home, false);
    await page.getByTestId("story-step-storyboard").click();
    await expect(page.getByTestId("story-act-0")).toBeVisible({
      timeout: 30_000,
    });

    await page.getByTestId("story-board-continuity").click();

    // The stand-in's check patches the first shot it was shown, and the board
    // says nothing was added or lost.
    await expect(
      page.getByTestId("story-act-0").getByTestId("story-kf-content-0"),
    ).toContainText("Staging check wrote this frame.", { timeout: 60_000 });
    const contents = await persistedContents(page);
    expect(contents[0]).toBe("Staging check wrote this frame.");
    expect(contents.length).toBeGreaterThan(1);
  } finally {
    forgetHome(home);
  }
});
