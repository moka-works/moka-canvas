import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";
import {
  addNode,
  APP,
  configureTheWholeStudio,
  createProject,
  forgetHome,
  forgetProjects,
  projectHome,
  showAssets,
} from "./helpers";
import { providerCalls } from "./mock-provider";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Served {
  moka: {
    canvas: {
      id: string;
      nodes: {
        id: string;
        kind: string;
        data: {
          assetId?: string;
          resultNodeIds?: string[];
          resultSlots?: {
            assetId?: string;
            isPrimary?: boolean;
          }[];
        };
      }[];
    }[];
    resources: Record<string, { id: string }[]>;
  };
}

/** The document as the server holds it, which is the only copy that counts. */
async function served(): Promise<Served> {
  const response = await fetch(`${APP}/api/v1/projects/current`);
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as Served;
}

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

/**
 * Asking the same shot again replaces what the node shows.
 *
 * A video node is the working copy of one shot: the second answer is what the
 * canvas shows afterwards, and the first stays reachable as one of the node's
 * results rather than being turned into a second card beside it. This is the
 * report that made every media kind do the same as a text node already did.
 */
test("asking a shot again replaces the one the node shows", async ({
  page,
}) => {
  const home = projectHome("canvas-video-rerun");
  await forgetProjects();
  await configureTheWholeStudio();
  await page.goto("/");
  await page.setViewportSize({ width: 1280, height: 720 });
  await createProject(page, join(home, "project"), "Shot Again");

  await addNode(page, "Video");
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("prompt-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await panel.getByLabel("Prompt for Video").fill("A lantern over a lake.");
  await panel.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText("Filed under Videos (1)")).toBeVisible({
    timeout: 30_000,
  });

  const before = await served();
  const beforeShot = before.moka.canvas[0].nodes[0];
  expect(beforeShot.kind).toBe("video");
  const firstAsset = beforeShot.data.assetId;
  expect(firstAsset).toBeTruthy();
  expect(before.moka.resources.videos).toHaveLength(1);

  // The same ask, from the same panel: a second generation, not a replay.
  await panel.getByRole("button", { name: "Run", exact: true }).click();
  await expect
    .poll(async () => (await providerCalls()).length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(async () => (await served()).moka.resources.videos.length, {
      timeout: 20_000,
    })
    .toBe(2);

  const after = await served();
  const nodes = after.moka.canvas[0].nodes;
  expect(nodes, "one video node, not a second one beside it").toHaveLength(1);
  const shot = nodes[0];
  const secondAsset = shot.data.assetId;
  expect(secondAsset, "the node shows the newest shot").not.toBe(firstAsset);
  expect(shot.data.resultNodeIds ?? [], "no card was made for it").toEqual([]);

  // The shot the node held is still a result, and is no longer the one shown.
  const slots = shot.data.resultSlots ?? [];
  expect(slots.map((slot) => slot.assetId)).toEqual([firstAsset, secondAsset]);
  expect(slots.map((slot) => slot.isPrimary)).toEqual([false, true]);

  // What stands on the canvas is the new answer: one face, playing the asset
  // the node points at now.
  const face = page.getByTestId("video-card-face");
  await expect(face).toHaveCount(1);
  await expect(face.locator("video")).toHaveAttribute(
    "src",
    new RegExp(`/assets/${secondAsset}`),
  );

  forgetHome(home);
});
