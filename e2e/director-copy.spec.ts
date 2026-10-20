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
    canvas: {
      nodes: {
        id: string;
        kind: string;
        data: { director?: { sceneId: string } };
      }[];
    }[];
    directorScenes?: { id: string; title: string }[];
  };
}

async function served(): Promise<Served> {
  const response = await fetch(`${APP}/api/v1/projects/current`);
  if (!response.ok) throw new Error(`reading the project: ${response.status}`);
  return (await response.json()) as Served;
}

test("a copied director desk opens onto a scene of its own", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await forgetProjects();
  await page.goto("/");
  await createProject(
    page,
    join(projectHome("director-copy"), "project"),
    "Director Copy",
  );
  await addNode(page, "Director desk");
  await page
    .getByRole("dialog", { name: "Start a director desk" })
    .getByRole("button", { name: /Empty stage/ })
    .click();
  await expect(page.getByTestId("director-page")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Back to canvas" }).click();
  await expect(page.getByTestId("canvas-surface")).toBeVisible();

  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect
    .poll(async () => (await served()).moka.canvas[0].nodes.length)
    .toBe(2);
  await expect
    .poll(async () => (await served()).moka.directorScenes?.length)
    .toBe(2);

  const copied = await served();
  const desks = copied.moka.canvas[0].nodes.filter(
    (node) => node.kind === "director",
  );
  const scenes = copied.moka.directorScenes ?? [];
  expect(desks).toHaveLength(2);
  expect(desks[0].data.director?.sceneId).not.toBe(
    desks[1].data.director?.sceneId,
  );
  expect(new Set(desks.map((desk) => desk.data.director?.sceneId))).toEqual(
    new Set(scenes.map((scene) => scene.id)),
  );

  // One undo takes the pasted desk and its stage together.
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await served()).moka.canvas[0].nodes.length)
    .toBe(1);
  await expect
    .poll(async () => (await served()).moka.directorScenes?.length)
    .toBe(1);
});
