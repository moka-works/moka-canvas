import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  addNode,
  APP,
  createProject,
  forgetProjects,
  openRecent,
  persistedNodeCount,
  projectHome,
} from "./helpers";

interface ServedAsset {
  id: string;
  name: string;
  path: string;
  mime: string;
  tags?: string[];
}

interface ServedNode {
  id: string;
  kind: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  data: {
    director?: {
      sceneId: string;
      frameAssetId?: string;
      blockingAssetId?: string;
      frameShotId?: string;
      directionText?: string;
    };
    generation?: { params: Record<string, unknown> };
  };
}

interface Served {
  root: string;
  moka: {
    metadata: { revision: number };
    canvas: {
      id: string;
      viewport: { x: number; y: number; zoom: number };
      nodes: ServedNode[];
    }[];
    directorScenes?: { id: string; shots: { id: string; name: string }[] }[];
    resources: Record<string, ServedAsset[]>;
  };
}

async function settled(response: Response, what: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`${what}: ${response.status} ${await response.text()}`);
  }
}

async function served(): Promise<Served> {
  const response = await fetch(`${APP}/api/v1/projects/current`);
  await settled(response, "reading the project");
  return (await response.json()) as Served;
}

/** The width and height a PNG says it has, read from its own header. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function startDesk(page: Parameters<typeof addNode>[0]) {
  await addNode(page, "Director desk");
  const dialog = page.getByRole("dialog", {
    name: "Start a director desk",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Empty stage/ }).click();
  await expect(page.getByTestId("director-page")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('[data-renderer-ready="true"]')).toBeVisible({
    timeout: 30_000,
  });
}

test("a delivered shot becomes an asset and the card's output", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const home = projectHome("director-apply");
  const root = join(home, "project");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, root, "Director Apply");
  await startDesk(page);

  await page.getByRole("button", { name: "Deliver frame" }).click();
  const dialog = page.getByRole("dialog", { name: "Deliver shot" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Resolution").selectOption("1280");
  await expect(dialog).toContainText("1280 × 720");
  await dialog.getByRole("button", { name: "Deliver", exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });

  const project = await served();
  const card = project.moka.canvas[0].nodes.find(
    (node) => node.kind === "director",
  );
  const frameId = card?.data.director?.frameAssetId;
  expect(frameId).toBeTruthy();
  const scene = project.moka.directorScenes?.find(
    (entry) => entry.id === card?.data.director?.sceneId,
  );
  expect(card?.data.director?.frameShotId).toBe(scene?.shots[0]?.id);
  expect(card?.data.director?.directionText?.length).toBeGreaterThan(0);

  const frame = project.moka.resources.images?.find(
    (asset) => asset.id === frameId,
  );
  expect(frame?.tags).toEqual(
    expect.arrayContaining(["Shot frame", `shot:${scene?.shots[0]?.name}`]),
  );
  const bytes = new Uint8Array(
    await (
      await fetch(`${APP}/api/v1/projects/current/assets/${frameId}`)
    ).arrayBuffer(),
  );
  expect(pngSize(bytes)).toEqual({ width: 1280, height: 720 });

  // Leaving the desk puts the delivery on the canvas history, and one undo
  // puts the card's outputs back the way they were.
  await page.getByRole("button", { name: "Back to canvas" }).click();
  await expect(page.getByTestId("canvas-surface")).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => {
      const after = await served();
      return after.moka.canvas[0].nodes.find((node) => node.kind === "director")
        ?.data.director?.frameAssetId;
    })
    .toBeUndefined();
});

test("a control pass goes to the shelf and leaves the card's output alone", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const home = projectHome("director-control");
  const root = join(home, "project");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, root, "Director Control");
  await startDesk(page);

  await page.getByRole("button", { name: "Deliver frame" }).click();
  const dialog = page.getByRole("dialog", { name: "Deliver shot" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Resolution").selectOption("1280");
  await dialog.getByLabel("Frame render").selectOption("depth");
  await expect(dialog).toContainText("asset shelf only");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });

  const project = await served();
  const card = project.moka.canvas[0].nodes.find(
    (node) => node.kind === "director",
  );
  expect(card?.data.director?.frameAssetId).toBeUndefined();
  const control = project.moka.resources.images?.find((asset) =>
    asset.tags?.includes("Control frame"),
  );
  expect(control?.tags).toEqual(
    expect.arrayContaining(["Control frame", "Depth"]),
  );
});

test("a blocking reference is recorded as a WebM beside the frame", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const home = projectHome("director-blocking");
  const root = join(home, "project");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, root, "Director Blocking");
  await startDesk(page);

  await page.getByRole("button", { name: "Deliver frame" }).click();
  const dialog = page.getByRole("dialog", { name: "Deliver shot" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Resolution").selectOption("1280");
  await dialog.getByLabel("Also record a blocking reference").check();
  await dialog.getByLabel("Transcode the blocking reference to MP4").uncheck();
  await dialog.getByRole("button", { name: "Deliver", exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 120_000 });

  const project = await served();
  const card = project.moka.canvas[0].nodes.find(
    (node) => node.kind === "director",
  );
  const blockingId = card?.data.director?.blockingAssetId;
  expect(blockingId).toBeTruthy();
  expect(card?.data.director?.frameAssetId).toBeTruthy();
  const blocking = project.moka.resources.videos?.find(
    (asset) => asset.id === blockingId,
  );
  expect(blocking?.mime).toBe("video/webm");
  expect(blocking?.tags).toEqual(
    expect.arrayContaining(["Blocking reference"]),
  );
});

test("without ffmpeg the blocking reference stays a WebM and says so", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const home = projectHome("director-transcode");
  const root = join(home, "project");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, root, "Director Transcode");
  await startDesk(page);

  await page.getByRole("button", { name: "Deliver frame" }).click();
  const dialog = page.getByRole("dialog", { name: "Deliver shot" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Resolution").selectOption("1280");
  await dialog.getByLabel("Also record a blocking reference").check();
  await dialog.getByRole("button", { name: "Deliver", exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 120_000 });

  // The suite's server is pointed at a path with no ffmpeg, the way a machine
  // without one is; the recording is kept and the fallback is stated.
  const toast = page.locator(".toast").filter({ hasText: "Delivered" });
  await expect(toast).toBeVisible();
  await toast.locator(".toast-body").click();
  await expect(toast.locator(".toast-detail")).toContainText("ffmpeg");

  const project = await served();
  const card = project.moka.canvas[0].nodes.find(
    (node) => node.kind === "director",
  );
  const blocking = project.moka.resources.videos?.find(
    (asset) => asset.id === card?.data.director?.blockingAssetId,
  );
  expect(blocking?.name.endsWith(".webm")).toBe(true);
  expect(blocking?.mime).toBe("video/webm");
});

test("a blocking reference puts a downstream video node in reference mode", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const home = projectHome("director-handoff");
  const root = join(home, "project");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, root, "Director Handoff");
  await startDesk(page);
  await page.getByRole("button", { name: "Back to canvas" }).click();
  await expect(page.getByTestId("canvas-surface")).toBeVisible();

  // The stock helper double-clicks the middle of the surface, which is where
  // the desk card already is; a spot away from it opens the add menu.
  const surface = page.getByTestId("canvas-surface");
  const panBox = await surface.boundingBox();
  await page.mouse.dblclick(
    panBox!.x + panBox!.width * 0.5,
    panBox!.y + panBox!.height * 0.08,
  );
  await page
    .getByRole("menu", { name: "Add node" })
    .getByRole("menuitem", { name: "Video", exact: true })
    .click();
  await expect.poll(() => persistedNodeCount(page)).toBe(2);

  const before = await served();
  const canvas = before.moka.canvas[0];
  const director = canvas.nodes.find((node) => node.kind === "director")!;
  const video = canvas.nodes.find((node) => node.kind === "video")!;
  const response = await fetch(`${APP}/api/v1/projects/current/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedRevision: before.moka.metadata.revision,
      commands: [
        {
          type: "addEdge",
          canvasId: canvas.id,
          edge: {
            id: "edge-director-blocking",
            source: { nodeId: director.id, portId: "blocking" },
            target: { nodeId: video.id, portId: "videos" },
            createdAt: new Date().toISOString(),
          },
        },
      ],
    }),
  });
  await settled(response, "wiring the blocking reference");

  await page.reload();
  await openRecent(page, "Director Handoff");
  await expect(page.getByTestId("canvas-surface")).toBeVisible();

  // The video card sits where the page last drew it; its own bounds and the
  // saved camera say where that is on screen.
  const after = await served();
  const current = after.moka.canvas[0];
  const box = await page.getByTestId("canvas-surface").boundingBox();
  const bounds = current.nodes.find((node) => node.id === video.id)!.bounds;
  const view = current.viewport;
  const point = {
    x:
      box!.x +
      (bounds.x + bounds.width / 2 - view.x) * view.zoom +
      box!.width / 2,
    y:
      box!.y +
      (bounds.y + bounds.height / 2 - view.y) * view.zoom +
      box!.height / 2,
  };
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press("Enter");

  const panel = page.getByTestId("prompt-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await panel.getByRole("tab", { name: "Parameter", exact: true }).click();
  const note = panel.getByTestId("blocking-reference-note");
  await expect(note).toContainText("reference mode");
  await expect(panel.getByLabel("Pictures are")).toHaveValue("reference");

  // Choosing auto is kept, and warned about rather than overridden.
  await panel.getByLabel("Pictures are").selectOption("auto");
  await expect(note).toContainText("auto mode");
  await panel.getByRole("button", { name: "Use reference mode" }).click();
  await expect(panel.getByLabel("Pictures are")).toHaveValue("reference");
});
