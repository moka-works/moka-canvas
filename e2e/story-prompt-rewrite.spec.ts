import { join } from "node:path";
import { expect, test, type Page } from "./fixtures";
import {
  configureWordsAndPictures,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openSeededStory,
  projectHome,
} from "./helpers";
import { SENTENCE, providerCalls } from "./mock-provider";

/**
 * A bulk press rewriting its places' words before it draws.
 *
 * The switch beside the count asks a text model to put each place's prompt in
 * its picture model's contract first. The words are rewritten once per place,
 * however many pictures its set holds, and every picture of the set is then
 * asked with that one answer.
 */

/** The notes the server kept with the pictures waiting in the cast's places. */
async function pendingNotes(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        stories?: {
          elements?: {
            main?: {
              takes?: { note?: string }[];
              pending?: { takes?: { note?: string }[] };
            };
          }[];
        }[];
      };
    };
    return (body.moka?.stories?.[0]?.elements ?? []).flatMap((element) =>
      (element.main?.pending?.takes ?? element.main?.takes ?? []).map(
        (take) => take.note ?? "",
      ),
    );
  });
}

/** The same, for the pictures waiting in a boarded episode's shots. */
async function boardPendingNotes(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        stories?: {
          chapters?: {
            acts?: {
              keyframes?: {
                art?: {
                  takes?: { note?: string }[];
                  pending?: { takes?: { note?: string }[] };
                };
              }[];
            }[];
          }[];
        }[];
      };
    };
    return (body.moka?.stories?.[0]?.chapters ?? []).flatMap((chapter) =>
      (chapter.acts ?? []).flatMap((act) =>
        (act.keyframes ?? []).flatMap((keyframe) =>
          (keyframe.art?.pending?.takes ?? keyframe.art?.takes ?? []).map(
            (take) => take.note ?? "",
          ),
        ),
      ),
    );
  });
}

/** How many words the stand-in was asked to write so far. */
async function wordsAsked(): Promise<number> {
  return (await providerCalls()).filter((call) => call.path.includes("chat"))
    .length;
}

test("one press rewrites each place once, then draws its set", async ({
  page,
}) => {
  const home = projectHome("story-prompt-rewrite");
  await forgetProjects();
  await configureWordsAndPictures();
  try {
    await page.goto("/");
    await createProject(
      page,
      join(home, "project"),
      "Rewritten Prompts",
      "Story",
    );
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

    // The switch stands beside the count and is off until the reader asks.
    const rewrite = page.getByTestId("story-elements-draw-all-rewrite");
    await expect(rewrite).not.toBeChecked();
    await page.getByTestId("story-elements-draw-all-count").selectOption("2");
    await rewrite.check();
    const before = await wordsAsked();
    await page.getByTestId("story-elements-draw-all").click();

    // Four places, two pictures each: every set waits whole in its place, and
    // the words the text model was asked for are four rather than eight.
    await expect(
      page.getByTestId("story-slot-main-candidates").first(),
    ).toBeVisible({ timeout: 90_000 });
    expect((await wordsAsked()) - before).toBe(4);

    // Every picture of every set carries the one rewritten prompt.
    await expect.poll(async () => pendingNotes(page)).toContain(SENTENCE);
    const notes = await pendingNotes(page);
    expect(notes.length).toBe(8);
    expect(notes.every((note) => note === SENTENCE)).toBe(true);
  } finally {
    forgetHome(home);
  }
});

test("the board's press rewrites each frame once before drawing its set", async ({
  page,
}) => {
  const home = projectHome("story-prompt-rewrite-board");
  await forgetProjects();
  await configureWordsAndPictures();
  try {
    await openSeededStory(page, home, false);
    await page.getByTestId("story-step-storyboard").click();
    const draw = page.getByTestId("story-board-draw-missing");
    await expect(draw).toBeVisible({ timeout: 30_000 });
    const missing = Number(
      /\((\d+)\)/.exec((await draw.textContent()) ?? "")?.[1],
    );
    expect(missing).toBeGreaterThan(0);

    await page.getByTestId("story-board-draw-missing-count").selectOption("2");
    await page.getByTestId("story-board-draw-missing-rewrite").check();
    const before = await wordsAsked();
    await draw.click();

    // One rewrite per frame rather than one per request: a frame asked for two
    // pictures takes one text ask, and both copies carry its answer.
    await expect(
      page.locator('[data-testid$="-candidates"]').first(),
    ).toBeVisible({ timeout: 90_000 });
    expect((await wordsAsked()) - before).toBe(missing);
    await expect.poll(async () => boardPendingNotes(page)).toContain(SENTENCE);
    const notes = await boardPendingNotes(page);
    expect(notes.length).toBe(missing * 2);
    expect(notes.every((note) => note === SENTENCE)).toBe(true);
  } finally {
    forgetHome(home);
  }
});
