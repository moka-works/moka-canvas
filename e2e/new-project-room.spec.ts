import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  backToLauncher,
  beginProject,
  createProject,
  forgetHome,
  forgetProjects,
  projectHome,
} from "./helpers";

test("a new project asks where to start and lands in the chosen room", async ({
  page,
}) => {
  test.slow();
  const home = projectHome("room-picker");
  await forgetProjects();
  try {
    await page.goto("/");

    // The face of each card keeps its one-line purpose; the longer scene is
    // read on hover, not spent on the dialog.
    const picker = await beginProject(
      page,
      join(home, "story"),
      "Start in Story",
    );
    const detail = picker.getByTestId("room-picker-detail");
    await expect(detail).toHaveText(
      "Hover or focus a card to see when that room fits.",
    );
    await picker.getByTestId("room-choice-story").hover();
    await expect(detail).toContainText("Best when you start with a sentence");
    await picker.getByTestId("room-choice-story").click();
    await expect(page.getByTestId("story-page")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("banner").getByText("Start in Story", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await backToLauncher(page);

    // The board and the cutting room are the other two answers to the same
    // question, and each lands on its own room.
    await createProject(
      page,
      join(home, "canvas"),
      "Start in Canvas",
      "Canvas",
    );
    await backToLauncher(page);
    await createProject(page, join(home, "clip"), "Start in Clip", "Clip");
    await backToLauncher(page);

    // Stepping out is not a cancellation: the project is already made, so the
    // recent list keeps it and says so.
    const escaped = await beginProject(
      page,
      join(home, "escaped"),
      "Escaped Project",
    );
    await expect(escaped.getByTestId("room-choice-clip")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(escaped).toBeHidden();
    await expect(
      page.getByText("Project created. It is waiting in recent projects."),
    ).toBeVisible();
    await expect(
      page
        .locator("button.launcher-recent")
        .filter({ hasText: "Escaped Project" }),
    ).toBeVisible({ timeout: 10_000 });
  } finally {
    await forgetProjects();
    forgetHome(home);
  }
});
