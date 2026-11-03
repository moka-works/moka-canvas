import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";
import {
  createProject,
  forgetHome,
  forgetProjects,
  projectHome,
  showAssets,
} from "./helpers";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A video on the canvas: the file's own first frame where the card stands, and
 * the shot played in the card rather than in a dialog away from the graph it
 * belongs to.
 */
test("a video node shows its first frame and plays where it stands", async ({
  page,
}) => {
  const home = projectHome("canvas-video");
  await forgetProjects();
  await page.goto("/");
  await page.setViewportSize({ width: 1280, height: 720 });
  await createProject(page, join(home, "project"), "Reel");

  await showAssets(page);
  await page.getByLabel("Import files", { exact: true }).setInputFiles({
    name: "clip.mp4",
    mimeType: "video/mp4",
    buffer: readFileSync(join(HERE, "fixtures", "clip.mp4")),
  });

  // The import lands the file as a card, and the card wears the file itself
  // as far as its header: no poster is made for it anywhere, so what shows is
  // the picture the browser draws on its own.
  const face = page.getByTestId("video-card-face");
  await expect(face).toBeVisible({ timeout: 10_000 });
  const video = face.locator("video");
  await expect(video).toHaveAttribute(
    "src",
    /\/api\/v1\/projects\/current\/assets\//,
  );
  await expect(video).toHaveAttribute("preload", "metadata");
  await expect(face.getByText("160×120 · 0:03")).toBeVisible();
  const play = face.getByRole("button", { name: /^Play / });
  await expect(play).toBeVisible();

  // The face is a picture over the card, not a wall between it and the canvas:
  // a press beside the button lands on the card and selects it.
  const box = await face.boundingBox();
  if (!box) throw new Error("the face is not on screen to be pressed");
  await page.mouse.click(box.x + 6, box.y + 6);
  await expect(page.getByTestId("prompt-panel")).toBeVisible();

  // Pressing the button hands the card to the file: it plays where it stands,
  // with its own controls, and the button steps aside for them.
  await play.click();
  await expect
    .poll(() =>
      video.evaluate(
        (el) => (el as unknown as { currentTime: number }).currentTime,
      ),
    )
    .toBeGreaterThan(0.2);
  expect(
    await video.evaluate((el) => (el as unknown as { paused: boolean }).paused),
  ).toBe(false);
  await expect(video).toHaveAttribute("controls", "");
  await expect(face.getByRole("button", { name: /^Play / })).toHaveCount(0);

  forgetHome(home);
});
