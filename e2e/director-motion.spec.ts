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
      objects: {
        keyframes: { time: number; easing?: string }[];
        boneTracks?: unknown[];
      }[];
      cameras: {
        keyframes: { time: number; easing?: string }[];
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

test("an actor and the camera move on a shot's clock", async ({ page }) => {
  const home = projectHome("director-motion");
  const root = join(home, "project");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, root, "Director Motion");

  await addNode(page, "Director desk");
  await page
    .getByRole("dialog", { name: "Start a director desk" })
    .getByRole("button", { name: /Empty stage/ })
    .click();
  await expect(page.getByTestId("director-page")).toBeVisible({
    timeout: 20_000,
  });
  const skip = page.getByRole("button", { name: "Skip" });
  if (await skip.isVisible().catch(() => false)) await skip.click();

  await page.getByRole("tab", { name: "Actors" }).click();
  await page.getByRole("button", { name: "Standard adult" }).click();
  await page.getByRole("tab", { name: "Motion" }).click();
  await expect(page.getByRole("region", { name: "Blocking" })).toBeVisible();

  // AutoKey writes the edit at the playhead; a second keyframe is recorded by
  // moving the playhead and changing a value.
  await page.getByLabel("AutoKey").check();
  await savedAfter(page, () =>
    page.getByRole("button", { name: "Record keyframe" }).click(),
  );
  const ruler = page.locator(".director-ruler");
  const rulerBox = await ruler.boundingBox();
  expect(rulerBox).not.toBeNull();
  await page.mouse.click(
    rulerBox!.x + rulerBox!.width * 0.6,
    rulerBox!.y + rulerBox!.height / 2,
  );
  const positionX = page.getByRole("spinbutton", { name: "X" }).first();
  await savedAfter(page, async () => {
    await positionX.fill("1.5");
    await positionX.press("Enter");
  });

  await expect
    .poll(async () => {
      const project = await served();
      return project.moka.directorScenes?.[0].objects[0]?.keyframes.length;
    })
    .toBe(2);
  const moving = await served();
  const times =
    moving.moka.directorScenes?.[0].objects[0].keyframes.map(
      (frame) => frame.time,
    ) ?? [];
  expect(Math.min(...times)).toBe(0);
  expect(Math.max(...times)).toBeCloseTo(3.6, 2);

  // Playing advances the clock, and stopping leaves it where it was.
  await page.getByRole("button", { name: "Play" }).click();
  await expect
    .poll(async () => page.locator(".director-time").innerText(), {
      timeout: 4000,
    })
    .not.toContain("0.00s /");
  await page.getByRole("button", { name: "Pause" }).click();

  // The keyframes are buttons; one can be eased and deleted.
  await expect(page.locator(".director-keyframe")).toHaveCount(2);
  await page.locator(".director-keyframe").nth(1).click();
  await page.getByLabel("Easing", { exact: false }).selectOption("smooth");
  await expect
    .poll(async () => {
      const project = await served();
      return project.moka.directorScenes?.[0].objects[0].keyframes.some(
        (frame) => frame.easing === "smooth",
      );
    })
    .toBe(true);
  await savedAfter(page, () =>
    page.getByRole("button", { name: "Delete keyframe" }).click(),
  );
  await expect(page.locator(".director-keyframe")).toHaveCount(1);

  // A drawn path becomes smoothed transform keyframes.
  await page.getByRole("tab", { name: "Actors" }).click();
  await page
    .locator(".director-row-main", { hasText: "Actor 1" })
    .first()
    .click();
  await page.getByRole("button", { name: "Draw a blocking path" }).click();
  const stage = page.locator(".director-stage");
  const stageBox = await stage.boundingBox();
  expect(stageBox).not.toBeNull();
  await savedAfter(page, async () => {
    await page.mouse.move(
      stageBox!.x + stageBox!.width * 0.35,
      stageBox!.y + stageBox!.height * 0.72,
    );
    await page.mouse.down();
    for (let step = 1; step <= 6; step += 1) {
      await page.mouse.move(
        stageBox!.x + stageBox!.width * (0.35 + step * 0.04),
        stageBox!.y + stageBox!.height * (0.72 - step * 0.01),
      );
    }
    await page.mouse.up();
  });
  await expect
    .poll(async () => {
      const project = await served();
      return project.moka.directorScenes?.[0].objects[0]?.keyframes.length;
    })
    .toBeGreaterThan(1);

  // A camera move puts a first and last frame on the shot's camera.
  await page.getByRole("tab", { name: "Shot", exact: true }).click();
  await page.getByLabel("Camera move").selectOption("push_in");
  await savedAfter(page, () =>
    page.getByRole("button", { name: "Apply the camera move" }).click(),
  );
  await expect(page.getByRole("tab", { name: "Motion" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const filmed = await served();
  expect(filmed.moka.directorScenes?.[0].cameras[0].keyframes).toHaveLength(2);

  await page.getByRole("button", { name: "Back to canvas" }).click();
  await expect(page.getByTestId("canvas-surface")).toBeVisible();
});
