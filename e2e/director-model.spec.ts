import { readFileSync } from "node:fs";
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
    resources?: { models?: { id: string; name: string }[] };
    directorScenes?: {
      objects: {
        kind: string;
        rig?: { status: string; boneMap: Record<string, string> };
        motionClips?: { name: string; duration: number }[];
      }[];
    }[];
  };
}

async function served(): Promise<Served> {
  const response = await fetch(`${APP}/api/v1/projects/current`);
  if (!response.ok) throw new Error(`reading the project: ${response.status}`);
  return (await response.json()) as Served;
}

test("an imported humanoid is mapped and its clips are kept", async ({
  page,
}) => {
  const home = projectHome("director-model");
  const root = join(home, "project");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, root, "Director Model");

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

  await page.getByRole("tab", { name: "Set" }).click();
  const upload = page.locator('.director-file-button input[type="file"]');
  await upload.setInputFiles({
    name: "humanoid.glb",
    mimeType: "model/gltf-binary",
    buffer: readFileSync(join("e2e", "fixtures", "humanoid.glb")),
  });
  const modelRow = page.getByRole("button", { name: /humanoid\.glb/ });
  await expect(modelRow.first()).toBeVisible({ timeout: 20_000 });
  // Uploading adds the model to the shelf and to the stage in one step.
  await expect(
    page.getByRole("button", { name: "Use this model as a performer" }),
  ).toBeVisible();

  const performerReady = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/projects/current/commands") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Use this model as a performer" })
    .dispatchEvent("click");
  await performerReady;
  await expect(page.getByText(/joints mapped/)).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByLabel("Animation clip", { exact: false }),
  ).toContainText("Idle");
  await expect
    .poll(
      async () =>
        (await served()).moka.directorScenes?.[0].objects[0]?.rig?.status,
      { timeout: 15_000 },
    )
    .toBe("ready");

  const project = await served();
  const object = project.moka.directorScenes?.[0].objects[0];
  expect(object?.kind).toBe("performer");
  expect(object?.rig?.status).toBe("ready");
  expect(Object.keys(object?.rig?.boneMap ?? {}).length).toBeGreaterThanOrEqual(
    8,
  );
  expect(object?.motionClips?.[0]?.name).toBe("Idle");
  expect(project.moka.resources?.models?.[0].name).toBe("humanoid.glb");

  // A format the desk does not read is refused with the reason and advice.
  await upload.setInputFiles({
    name: "actor.obj",
    mimeType: "text/plain",
    buffer: Buffer.from("v 0 0 0\n"),
  });
  await expect(page.getByText(/not a format this desk reads/)).toBeVisible({
    timeout: 10_000,
  });
});
