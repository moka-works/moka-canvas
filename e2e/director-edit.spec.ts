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
      objects: { kind: string; name: string }[];
      lights: unknown[];
      cameras: unknown[];
    }[];
  };
}

async function served(): Promise<Served> {
  const response = await fetch(`${APP}/api/v1/projects/current`);
  if (!response.ok) throw new Error(`reading the project: ${response.status}`);
  return (await response.json()) as Served;
}

/** Runs an action that edits the scene and waits for its save to land. */
async function savedAfter(
  page: import("@playwright/test").Page,
  action: () => Promise<void>,
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

test("the board stages a scene and the document keeps it", async ({ page }) => {
  const home = projectHome("director-edit");
  const root = join(home, "project");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, root, "Director Edit");

  await addNode(page, "Director desk");
  await page
    .getByRole("dialog", { name: "Start a director desk" })
    .getByRole("button", { name: /Empty stage/ })
    .click();
  await expect(page.getByTestId("director-page")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('[data-renderer-ready="true"]')).toBeVisible({
    timeout: 30_000,
  });
  const skipGuide = page.getByRole("button", { name: "Skip" });
  if (await skipGuide.isVisible().catch(() => false)) {
    await skipGuide.click();
  }

  // An actor, placed by the desk and named in the cast.
  await page.getByRole("tab", { name: "Actors" }).click();
  await page.getByRole("button", { name: "Standard adult" }).click();
  await expect(
    page.locator(".director-row", { hasText: "Actor 1" }),
  ).toBeVisible();
  // The shot card follows the selection onto the object page.
  await expect(page.getByRole("tab", { name: "Current" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // A different pose.
  await page.getByLabel("Pose").selectOption("sit");

  // A prop from the set library.
  await page.getByRole("tab", { name: "Set" }).click();
  await page.getByRole("button", { name: "Long table" }).click();
  await expect(
    page.locator(".director-row", { hasText: "Long table" }),
  ).toBeVisible();

  // A spot light and a camera preset; the preset opens CAM.
  await page.getByRole("tab", { name: "Lights" }).click();
  await page.getByRole("button", { name: "Spot", exact: true }).click();
  await expect(
    page.locator(".director-row", { hasText: "Spot" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Cameras" }).click();
  await savedAfter(page, () =>
    page.getByRole("button", { name: "Front wide" }).click(),
  );
  await expect(page.locator(".director-view-label")).toHaveText("CAM");
  await page.getByRole("button", { name: "3D" }).click();

  // The local undo takes the camera back without touching the board's history.
  const before = await served();
  expect(before.moka.directorScenes?.[0].cameras).toHaveLength(2);
  await savedAfter(page, () =>
    page.getByRole("button", { name: "Undo" }).click(),
  );
  const undone = await served();
  expect(undone.moka.directorScenes?.[0].cameras).toHaveLength(1);
  await savedAfter(page, () =>
    page.getByRole("button", { name: "Redo" }).click(),
  );
  const redone = await served();
  expect(redone.moka.directorScenes?.[0].cameras).toHaveLength(2);

  // Modes converge the room without losing the scene.
  await page.getByRole("tab", { name: "Perform" }).click();
  await page.getByRole("tab", { name: "Lens" }).click();
  await page.getByRole("tab", { name: "Stage" }).click();

  // The scene persisted as it was staged.
  const project = await served();
  const scene = project.moka.directorScenes?.[0];
  expect(scene?.objects.map((object) => object.kind)).toEqual([
    "performer",
    "solid",
  ]);
  expect(scene?.objects.some((object) => object.name === "Actor 1")).toBe(true);
  expect(scene?.lights).toHaveLength(4);

  await page.getByRole("button", { name: "Back to canvas" }).click();
  await expect(page.getByTestId("canvas-surface")).toBeVisible();
});
