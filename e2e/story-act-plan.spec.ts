import { expect, test, type Page } from "./fixtures";
import {
  configureTheWholeStudio,
  forgetHome,
  forgetProjects,
  openSeededStory,
  projectHome,
} from "./helpers";

test.describe.configure({ timeout: 90_000 });

/** The second chapter's acts, as the server holds them. */
async function persistedActs(
  page: Page,
): Promise<Array<{ id: string; keyframes: number }>> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        stories?: {
          chapters?: {
            acts?: { id?: string; keyframes?: unknown[] }[];
          }[];
        }[];
      };
    };
    return (body.moka?.stories?.[0]?.chapters?.[1]?.acts ?? []).map((act) => ({
      id: act.id ?? "",
      keyframes: (act.keyframes ?? []).length,
    }));
  });
}

async function persistedPlans(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        stories?: {
          chapters?: { acts?: { plan?: string }[] }[];
        }[];
      };
    };
    return (body.moka?.stories?.[0]?.chapters?.[1]?.acts ?? []).map(
      (act) => act.plan ?? "",
    );
  });
}

test("plans a chapter's acts before its shots, and keeps a hand-written plan", async ({
  page,
}) => {
  const home = projectHome("story-act-plan");
  await forgetProjects();
  await configureTheWholeStudio();
  try {
    await openSeededStory(page, home, false);
    await page.getByTestId("story-step-storyboard").click();
    // The second episode has no board: its acts are planned before any shot.
    await page.getByTestId("story-board-chapter-1").click();
    await page.getByTestId("story-board-plan-acts").click();

    await expect(page.getByTestId("story-act-0")).toBeVisible({
      timeout: 60_000,
    });
    const firstPlan = page.getByTestId("story-act-plan-text-0");
    await expect(firstPlan).toHaveValue(/announcement says the train/);

    // The plan is the reader's as much as the model's.
    await firstPlan.fill("She waits until the lamp goes out.");
    await firstPlan.blur();
    await expect
      .poll(async () => (await persistedPlans(page))[0], { timeout: 30_000 })
      .toBe("She waits until the lamp goes out.");

    // Both planned acts stand: the plan is the chapter's acts, not one scene.
    await expect(page.getByTestId("story-act-1")).toBeVisible();
    const planned = await persistedActs(page);
    expect(planned.length).toBe(2);

    // The board that follows is written onto those same acts, by id.
    await page.getByTestId("story-board-generate").click();
    await expect
      .poll(
        async () => (await persistedActs(page)).map((act) => act.keyframes),
        { timeout: 60_000 },
      )
      .toEqual([1, 1]);
    expect((await persistedActs(page)).map((act) => act.id)).toEqual(
      planned.map((act) => act.id),
    );
  } finally {
    forgetHome(home);
  }
});
