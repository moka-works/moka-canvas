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
    directorScenes?: { id: string; objects: { id: string }[] }[];
    canvas: {
      nodes: { kind: string; data: { director?: { sceneId: string } } }[];
    }[];
  };
}

async function served(): Promise<Served> {
  const response = await fetch(`${APP}/api/v1/projects/current`);
  if (!response.ok) throw new Error(`reading the project: ${response.status}`);
  return (await response.json()) as Served;
}

test("a director desk opens onto its staged scene and its views switch", async ({
  page,
}) => {
  const home = projectHome("director-entry");
  const root = join(home, "project");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, root, "Director Entry");

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await addNode(page, "Director desk");
  const dialog = page.getByRole("dialog", {
    name: "Start a director desk",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Two at a table/ }).click();

  await expect(page.getByTestId("director-page")).toBeVisible({
    timeout: 20_000,
  });
  const viewport = page.locator('[data-renderer-ready="true"]');
  await expect(viewport).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("canvas")).toBeVisible();

  // The stage takes the room it is given: the shot card sits against the
  // window's right edge instead of trailing a collapsed center column.
  const cardBox = await page.locator(".director-shot-card").boundingBox();
  const windowWidth = page.viewportSize()?.width;
  expect(cardBox).not.toBeNull();
  expect(windowWidth).toBeDefined();
  expect(Math.round(cardBox!.x + cardBox!.width)).toBe(windowWidth);

  // The scene is in the document, and the card opens onto it.
  const project = await served();
  expect(project.moka.directorScenes).toHaveLength(1);
  expect(project.moka.directorScenes?.[0].objects.length).toBeGreaterThan(0);
  const card = project.moka.canvas[0].nodes.find(
    (node) => node.kind === "director",
  );
  expect(card?.data.director?.sceneId).toBe(
    project.moka.directorScenes?.[0].id,
  );

  // The camera view is the shot's own; the orthographic views show the
  // stage without changing the free view.
  await page.getByRole("button", { name: "CAM", exact: true }).click();
  await expect(page.locator(".director-view-label")).toHaveText("CAM");
  await page.getByRole("button", { name: "TOP", exact: true }).click();
  await expect(page.locator(".director-view-label")).toHaveText("TOP");
  await page.getByRole("button", { name: "FRONT", exact: true }).click();
  await expect(page.locator(".director-view-label")).toHaveText("FRONT");
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await expect(page.locator(".director-view-label")).toHaveCount(0);

  // Blockout swaps the material without freezing the viewport.
  await page.getByLabel("Render").selectOption("blockout");
  await page.getByLabel("Render").selectOption("lit");

  await page.getByRole("button", { name: "Back to canvas" }).click();
  await expect(page.getByTestId("canvas-surface")).toBeVisible();
  await expect(page.getByTestId("director-card-face")).toBeVisible();
  expect(errors).toEqual([]);
});
