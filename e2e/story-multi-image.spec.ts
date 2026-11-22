import { join } from "node:path";
import { expect, test, type Page } from "./fixtures";
import {
  configureModels,
  configureWordsAndPictures,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openSeededStory,
  projectHome,
} from "./helpers";
import { PAINTER, STORYTELLER } from "./mock-provider";

test.describe.configure({ timeout: 120_000 });

/**
 * Pictures drawn a set at a time, kept as a choice rather than as takes one by
 * one arriving.
 *
 * One model call makes one drawing, so a place asked for three is three calls
 * side by side; the set stands whole in the place once all of them are home,
 * and the reader keeps one — with the rest still there to switch to later.
 */

/** What the first story's first keyframe place holds. */
async function firstFrame(page: Page): Promise<{
  takes: string[];
  pending: { count: number; takes: string[] } | null;
}> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        stories?: {
          chapters?: {
            acts?: {
              keyframes?: {
                art?: {
                  takes?: { assetIds?: string[] }[];
                  pending?: {
                    count?: number;
                    takes?: { assetIds?: string[] }[];
                  };
                };
              }[];
            }[];
          }[];
        }[];
      };
    };
    const art =
      body.moka?.stories?.[0]?.chapters?.[0]?.acts?.[0]?.keyframes?.[0]?.art;
    return {
      takes: (art?.takes ?? []).map((take) => take.assetIds?.[0] ?? ""),
      pending:
        art?.pending === undefined
          ? null
          : {
              count: art.pending.count ?? 0,
              takes: (art.pending.takes ?? []).map(
                (take) => take.assetIds?.[0] ?? "",
              ),
            },
    };
  });
}

/** Where a run asked for screenshots keeps them, if it asked at all. */
const SHOTS = process.env.MOKA_SHOT_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  // A toast is the room talking, not the work being shown; the screenshots
  // are taken with the room quiet.
  for (let at = 0; at < 20; at += 1) {
    if ((await page.locator(".toast").count()) === 0) break;
    const close = page.locator(".toast-close").first();
    if ((await page.locator(".toast-close").count()) > 0) await close.click();
    else await page.locator(".toast-body").first().click();
  }
  await page.screenshot({ path: join(SHOTS, name), fullPage: false });
}

async function painted(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page
        .locator(".story-candidate img")
        .evaluateAll((images) =>
          images.every(
            (image) =>
              (image as HTMLImageElement).complete &&
              (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
}

async function toTheElements(page: Page, home: string): Promise<void> {
  await page.goto("/");
  await createProject(page, join(home, "project"), "Sets of Pictures", "Story");
  await newStory(page, "Rain at Night");
  await page
    .getByTestId("story-idea-input")
    .fill("Eleven at night, and the last train stops where it should not.");
  await page.getByTestId("story-idea-duration-3").click();
  await page.getByTestId("story-confirm-idea").click();
  await expect(page.getByTestId("story-step-body-outline")).toBeVisible();
  await page.getByTestId("story-outline-start").click();
  await expect(page.locator(".story-chapter")).toHaveCount(3, {
    timeout: 30_000,
  });
  await page.getByTestId("story-confirm-outline").click();
  await page.getByTestId("story-step-elements").click();
  await page.getByTestId("story-elements-recognise").click();
  await expect(page.locator(".story-element")).toHaveCount(4, {
    timeout: 30_000,
  });
}

test("a place asked for three pictures waits for the set, then keeps the choice", async ({
  page,
}) => {
  const home = projectHome("story-multi-images");
  await forgetProjects();
  await configureWordsAndPictures();
  try {
    await toTheElements(page, home);

    // The press on the step's own right edge says how many each place draws.
    await page.getByTestId("story-elements-draw-all-count").selectOption("3");
    await expect(page.getByTestId("story-elements-draw-all-count")).toHaveValue(
      "3",
    );
    await shot(page, "elements-count-3.png");
    await page.getByTestId("story-elements-draw-all").click();

    // The set stands in the place whole, as a choice, not as takes landing one
    // at a time.
    const keeper = page.getByTestId("story-element-character-Keeper");
    await expect(keeper.getByTestId("story-slot-main-candidates")).toBeVisible({
      timeout: 90_000,
    });
    await expect(keeper.getByTestId("story-slot-main-choose")).toHaveCount(0);
    await expect(
      keeper.getByTestId("story-slot-main-candidates").locator("img"),
    ).toHaveCount(3);
    await keeper.evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    await shot(page, "elements-candidates.png");
    await keeper.getByTestId("story-slot-main-candidates").click();
    await expect(page.getByTestId("story-candidates")).toBeVisible();
    await expect(page.locator(".story-candidate")).toHaveCount(3);
    await painted(page);
    await shot(page, "elements-candidate-dialog.png");

    // Keeping the second one keeps all three, the chosen one in use.
    await page.getByTestId("story-candidate-1").click();
    await page.getByTestId("story-candidates-confirm").click();
    await expect(keeper.locator("img").first()).toBeVisible();
    await expect(keeper.getByTestId("story-slot-main-pick")).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const response = await fetch("/api/v1/projects/current");
          const body = (await response.json()) as {
            moka?: {
              stories?: {
                elements?: {
                  name?: string;
                  main?: { takes?: unknown[]; pending?: unknown };
                }[];
              }[];
            };
          };
          const element = (body.moka?.stories?.[0]?.elements ?? []).find(
            (each) => each.name === "Keeper",
          );
          return {
            takes: (element?.main?.takes ?? []).length,
            pending: element?.main?.pending !== undefined,
          };
        }),
      )
      .toEqual({ takes: 3, pending: false });

    // Every other place is drawn too, so the step can go on to the board.
    while ((await page.getByTestId("story-slot-main-candidates").count()) > 0) {
      await page.getByTestId("story-slot-main-candidates").first().click();
      await page.getByTestId("story-candidate-0").click();
      await page.getByTestId("story-candidates-confirm").click();
    }
    // A four-view sheet is still one drawing.
    await page.getByTestId("story-elements-views-all-count").selectOption("1");
    await page.getByTestId("story-elements-views-all").click();
    for (const name of ["Keeper", "Traveller"]) {
      await expect(
        page
          .getByTestId(`story-element-character-${name}`)
          .getByTestId("story-slot-turnaround")
          .locator("img"),
      ).toBeVisible({ timeout: 90_000 });
    }
    await expect(page.getByTestId("story-confirm-elements")).toBeEnabled();

    // The board's own press carries the same number, and its frames hold their
    // set the same way.
    await page.getByTestId("story-confirm-elements").click();
    await expect(page.getByTestId("story-step-body-storyboard")).toBeVisible();
    await page.getByTestId("story-board-generate").click();
    await expect(page.getByTestId("story-board-draw-missing")).toBeVisible({
      timeout: 60_000,
    });
    // A shot's own drawing dialog carries the same choice.
    await page
      .getByTestId("story-act-0")
      .getByTestId("story-kf-slot-0-generate")
      .click();
    await expect(page.getByTestId("story-image-prompt-dialog")).toBeVisible();
    await page.getByTestId("story-image-prompt-count").selectOption("3");
    await shot(page, "frame-image-dialog-count.png");
    await page.getByTestId("story-image-prompt-close").click();
    await page.getByTestId("story-board-draw-missing-count").selectOption("3");
    await shot(page, "storyboard-count-3.png");
    await page.getByTestId("story-board-draw-missing").click();
    await expect(
      page.locator('[data-testid$="-candidates"]').first(),
    ).toBeVisible({ timeout: 90_000 });
    await page.locator(".story-act").first().scrollIntoViewIfNeeded();
    await shot(page, "storyboard-candidates.png");
    await expect
      .poll(async () => (await firstFrame(page)).pending?.takes.length ?? 0)
      .toBeGreaterThan(0);
    const frame = await firstFrame(page);
    expect(frame.pending?.count).toBe(3);
    await page.locator('[data-testid$="-candidates"]').first().click();
    await expect(page.getByTestId("story-candidates")).toBeVisible();
    await painted(page);
    await shot(page, "storyboard-candidate-dialog.png");
  } finally {
    forgetHome(home);
  }
});

test("copies split over fast and slow painters stay one choice", async ({
  page,
}) => {
  const home = projectHome("story-split-image-set");
  await forgetProjects();
  await configureModels([
    { id: PAINTER, capability: "image", alias: "Painter" },
    { id: "slow-painter", capability: "image", alias: "Slow Painter" },
    { id: STORYTELLER, capability: "text", alias: "Storyteller" },
  ]);
  try {
    await openSeededStory(page, home);
    await page.getByTestId("story-model-image-toggle").click();
    await page.getByTestId(`story-model-image-option-${PAINTER}`).check();
    await page.getByTestId("story-model-image-option-slow-painter").check();

    const firstAct = page.getByTestId("story-act-0");
    await firstAct.getByTestId("story-kf-slot-0-again").click();
    const dialog = page.getByTestId("story-image-prompt-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("story-image-prompt-count").selectOption("2");
    await dialog.getByTestId("story-image-prompt-draw").click();

    const candidates = page.locator('[data-testid$="-candidates"]').first();
    await expect(candidates).toBeVisible({ timeout: 90_000 });
    await expect(candidates.locator("img")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator('[data-testid$="-choose"]')).toHaveCount(0);
    const batches = await page.evaluate(async () => {
      const response = await fetch("/api/v1/projects/current/story/jobs");
      const jobs = (await response.json()) as {
        kind: string;
        model: string;
        items: { copies?: number; setId?: string }[];
      }[];
      return jobs
        .filter((job) =>
          job.items.some(
            (item) => item.copies === 2 && item.setId !== undefined,
          ),
        )
        .map((job) => ({
          model: job.model,
          setIds: job.items.map((item) => item.setId),
        }));
    });
    expect(batches).toHaveLength(2);
    expect(new Set(batches.map((job) => job.model))).toEqual(
      new Set([PAINTER, "slow-painter"]),
    );
    expect(new Set(batches.flatMap((job) => job.setIds)).size).toBe(1);

    await candidates.click();
    await expect(page.getByTestId("story-candidates")).toBeVisible();
    await expect(page.locator(".story-candidate")).toHaveCount(2);
  } finally {
    forgetHome(home);
  }
});
