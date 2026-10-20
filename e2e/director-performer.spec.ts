import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  addNode,
  APP,
  createProject,
  forgetProjects,
  projectHome,
} from "./helpers";

interface ServedObject {
  name: string;
  kind: string;
  archetype?: string;
  pose?: string;
  boneOverrides?: Record<string, number[]>;
  actorBuild?: Record<string, unknown>;
  animalBuild?: Record<string, unknown>;
  boneTracks?: unknown[];
}

interface Served {
  moka: { directorScenes?: { objects: ServedObject[] }[] };
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

test("an actor takes poses, bones, and a quadruped form", async ({ page }) => {
  const home = projectHome("director-performer");
  const root = join(home, "project");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, root, "Director Performer");

  await addNode(page, "Director desk");
  await page
    .getByRole("dialog", { name: "Start a director desk" })
    .getByRole("button", { name: /Two at a table/ })
    .click();
  await expect(page.getByTestId("director-page")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('[data-renderer-ready="true"]')).toBeVisible({
    timeout: 30_000,
  });
  const skip = page.getByRole("button", { name: "Skip" });
  if (await skip.isVisible().catch(() => false)) await skip.click();

  // The first cast member of the duo template.
  await page.getByRole("tab", { name: "Actors" }).click();
  await page
    .locator(".director-row-main", { hasText: "Actor 1" })
    .first()
    .click();
  await expect(page.getByRole("tab", { name: "Current" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await savedAfter(page, () => page.getByLabel("Pose").selectOption("run"));

  // A joint through the inspector: head, twenty degrees around X.
  await page.getByLabel("Bone", { exact: false }).selectOption("head");
  await savedAfter(page, async () => {
    const x = page.getByLabel("X°", { exact: false });
    await x.fill("20");
    await x.press("Enter");
  });
  const turned = await served();
  const actor = turned.moka.directorScenes?.[0].objects.find(
    (object) => object.name === "Actor 1",
  );
  expect(actor?.pose).toBe("run");
  expect(actor?.boneOverrides?.head).toHaveLength(4);

  // A quadruped has the animal poses and no actor build.
  await page.getByRole("tab", { name: "Actors" }).click();
  await savedAfter(page, () =>
    page.getByRole("button", { name: "Dog", exact: true }).click(),
  );
  await expect(page.getByLabel("Pose")).toContainText("Standing");
  await savedAfter(page, () =>
    page.getByLabel("Pose").selectOption("animal_lie"),
  );
  let scene = await served();
  const dog = scene.moka.directorScenes?.[0].objects.find(
    (object) => object.archetype === "dog",
  );
  expect(dog?.pose).toBe("animal_lie");
  expect(dog?.animalBuild).toBeTruthy();
  expect(dog?.actorBuild).toBeUndefined();

  // Cross-form switching is asked about first, then clears the skeleton data.
  page.once("dialog", (dialog) => void dialog.accept());
  await savedAfter(page, () =>
    page.getByLabel("Archetype").selectOption("standard"),
  );
  scene = await served();
  const changed = scene.moka.directorScenes?.[0].objects.find(
    (object) => object.name === dog?.name,
  );
  expect(changed?.archetype).toBe("standard");
  expect(changed?.pose).toBe("neutral");
  expect(changed?.animalBuild).toBeUndefined();
  expect(changed?.actorBuild).toBeTruthy();
  expect(changed?.boneTracks).toBeUndefined();

  await page.getByRole("button", { name: "Back to canvas" }).click();
  await expect(page.getByTestId("canvas-surface")).toBeVisible();
});
