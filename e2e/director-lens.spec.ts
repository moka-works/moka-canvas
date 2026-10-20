import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  addNode,
  APP,
  createProject,
  forgetProjects,
  projectHome,
} from "./helpers";

interface Served {
  moka: {
    directorScenes?: {
      shots: {
        id: string;
        name: string;
        cameraId: string;
        aspectRatio: string;
      }[];
      cameras: {
        transform: { position: number[] };
        target: number[];
        keyframes: unknown[];
      }[];
    }[];
  };
}

async function served(): Promise<Served> {
  const response = await fetch(`${APP}/api/v1/projects/current`);
  if (!response.ok) throw new Error(`reading the project: ${response.status}`);
  return (await response.json()) as Served;
}

async function savedAfter(
  page: import("@playwright/test").Page,
  action: () => Promise<unknown> | void,
) {
  const landed = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/projects/current/commands") &&
      response.request().method() === "POST",
  );
  await action();
  await landed;
  await page
    .locator(".director-save-status")
    .filter({ hasText: "Saved" })
    .waitFor({ state: "visible", timeout: 10_000 });
}

test("the lens page frames the shot and compiles its direction", async ({
  page,
}) => {
  const home = projectHome("director-lens");
  const root = join(home, "project");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, root, "Director Lens");

  await addNode(page, "Director desk");
  await page
    .getByRole("dialog", { name: "Start a director desk" })
    .getByRole("button", { name: /Two at a table/ })
    .click();
  await expect(page.getByTestId("director-page")).toBeVisible({
    timeout: 20_000,
  });
  const skip = page.getByRole("button", { name: "Skip" });
  if (await skip.isVisible().catch(() => false)) await skip.click();

  await page.getByRole("tab", { name: "Lens" }).click();
  await page.getByRole("button", { name: "CAM", exact: true }).click();
  await expect(page.locator(".director-cam-guides")).toBeVisible();
  await expect(page.locator(".director-safe")).toHaveCount(2);

  await page.getByRole("tab", { name: "Shot", exact: true }).click();
  await page
    .locator("select")
    .filter({ has: page.locator('option[value="9:16"]') })
    .selectOption("9:16");
  const frame = page.locator(".director-cam-guides");
  await expect
    .poll(async () => {
      const box = await frame.boundingBox();
      return box ? box.width / box.height : 0;
    })
    .toBeCloseTo(9 / 16, 2);

  // The guides are runtime switches, not document fields.
  await page.getByLabel("Safe frames").uncheck();
  await expect(page.locator(".director-safe")).toHaveCount(0);
  await page.getByLabel("Safe frames").check();
  await page.getByLabel("Thirds").uncheck();
  await expect(page.locator(".director-thirds")).toHaveCount(0);

  // The compiled prompt follows the shot's camera and can be copied.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const prompt = page.locator("textarea[readonly]");
  await expect(prompt).toContainText("Shot design");
  await expect(prompt).toContainText("35mm lens");
  await savedAfter(page, async () => {
    const focal = page
      .getByRole("spinbutton", {
        name: /Focal length/,
      })
      .last();
    await focal.fill("50");
    await focal.press("Enter");
  });
  await expect(prompt).toContainText("50mm lens");
  await page.getByRole("button", { name: "Copy the prompt" }).click();
  await expect
    .poll(async () =>
      page.evaluate(() =>
        (
          navigator as unknown as {
            clipboard: { readText(): Promise<string> };
          }
        ).clipboard.readText(),
      ),
    )
    .toContain("50mm lens");

  // Aligning the camera to the free view writes the free camera's place.
  await page.getByRole("button", { name: "Align to the current view" }).click();
  await expect
    .poll(async () => {
      const project = await served();
      return project.moka.directorScenes?.[0].cameras[0].transform.position[0];
    })
    .toBeCloseTo(6, 1);

  // Shots copy and delete, with one always kept.
  const before = await served();
  expect(before.moka.directorScenes?.[0].shots).toHaveLength(1);
  await savedAfter(page, () =>
    page.getByRole("button", { name: "Duplicate shot" }).click(),
  );
  await expect(page.locator(".director-shot-chip")).toHaveCount(2);
  await savedAfter(page, () =>
    page.getByRole("button", { name: "Delete shot" }).click(),
  );
  await expect(page.locator(".director-shot-chip")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Delete shot" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "Back to canvas" }).click();
  await expect(page.getByTestId("canvas-surface")).toBeVisible();
});
