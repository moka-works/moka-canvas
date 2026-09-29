import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  configureModels,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openRecent,
  openStoryRoom,
  projectHome,
} from "./helpers";
import { STORYTELLER } from "./mock-provider";

/**
 * A step's failure count, as the room keeps it.
 *
 * The red number over a step counts the pieces that did not come back out of
 * the batches the room watched come home, and it is held in memory: a project
 * opened again begins the count from what is happening now, rather than
 * carrying the number a failure from some other day used to leave standing.
 */

test("the failure count starts over when the project is opened again", async ({
  page,
}) => {
  const home = projectHome("story-failure");
  await forgetProjects();
  await configureModels([
    { id: STORYTELLER, capability: "text", alias: "Storyteller" },
  ]);
  try {
    await page.goto("/");
    await createProject(page, join(home, "project"), "Story Failure");
    await openStoryRoom(page);
    await newStory(page, "Refused at Night");

    // The stand-in refuses anything asked with [refuse] in it, and the premise
    // is what the outline is asked about: the batch comes home short while the
    // room is watching, and the step it belongs to says so.
    await page
      .getByTestId("story-idea-input")
      .fill(
        "Eleven at night, and the last train [refuse] stops where it should not.",
      );
    await page.getByTestId("story-idea-duration-3").click();
    await page.getByTestId("story-confirm-idea").click();
    await expect(page.getByTestId("story-step-body-outline")).toBeVisible();
    await page.getByTestId("story-outline-start").click();

    await expect(page.getByTestId("story-step-failed-outline")).toHaveText(
      "1",
      { timeout: 30_000 },
    );

    // The project is put down and opened again: the record is on the list the
    // room reads, and the count over the step is not brought back with it.
    await page.reload();
    await openRecent(page, "Story Failure", "Story");

    await expect(page.getByTestId("story-page")).toBeVisible();
    await expect(page.getByTestId("story-step-failed-outline")).toHaveCount(0);
  } finally {
    await forgetHome(home);
  }
});
