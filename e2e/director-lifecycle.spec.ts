import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { addNode, createProject, forgetProjects, projectHome } from "./helpers";

/**
 * Entering and leaving the desk fifty times leaves nothing behind.
 *
 * The page owns a WebGL renderer and the scene loaded into it; every exit has
 * to give both up, or a long session collects contexts until the browser
 * refuses to make another. The count of desk canvases is read after each exit
 * rather than measured from a heap, because a renderer that was not disposed
 * is exactly a canvas that is still there.
 */
test("entering and leaving the desk fifty times stays clean", async ({
  page,
}) => {
  test.setTimeout(600_000);
  await page.addInitScript(() => {
    const held = globalThis as unknown as {
      localStorage: { setItem(key: string, value: string): void };
    };
    held.localStorage.setItem("moka-canvas:director-onboarding:v1", "done");
  });
  await forgetProjects();
  await page.goto("/");
  await createProject(
    page,
    join(projectHome("director-lifecycle"), "project"),
    "Director Lifecycle",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await addNode(page, "Director desk");
  await page
    .getByRole("dialog", { name: "Start a director desk" })
    .getByRole("button", { name: /Empty stage/ })
    .click();
  await expect(page.locator('[data-renderer-ready="true"]')).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Back to canvas" }).click();
  await expect(page.getByTestId("canvas-surface")).toBeVisible();

  for (let visit = 0; visit < 50; visit += 1) {
    await page.getByRole("button", { name: "Enter director desk" }).click();
    await expect(page.getByTestId("director-page")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('[data-renderer-ready="true"]')).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Back to canvas" }).click();
    await expect(page.getByTestId("canvas-surface")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator(".director-viewport canvas")).toHaveCount(0);
  }

  expect(errors).toEqual([]);
});
