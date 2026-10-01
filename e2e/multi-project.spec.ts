import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  APP,
  addNode,
  createProject,
  forgetHome,
  forgetProjects,
  projectHome,
  showAssets,
} from "./helpers";

// A tiny valid PNG (1x1 transparent pixel), for a picture only one of the two
// projects holds.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * What one window's project holds, asked of the server by name.
 *
 * The document on disk is a packed file rather than JSON, so what a project
 * holds is read the way any client reads it: through the server, naming the
 * project rather than trusting whichever was opened most recently. The name
 * is the one the window itself speaks for it — not a lookup through the
 * launcher's list, which is one list shared by every spec and may be cleared
 * by another one mid-run.
 */
async function viewOf(
  page: Page,
  window: string,
): Promise<{ nodes: number; images: number }> {
  const id = await page.evaluate(() => {
    const Browser = globalThis as unknown as {
      sessionStorage: { getItem(key: string): string | null };
    };
    return Browser.sessionStorage.getItem("moka.canvas.project");
  });
  if (id === null) throw new Error(`the ${window} window names no project`);
  const opened = (await (
    await fetch(
      `${APP}/api/v1/projects/current?project=${encodeURIComponent(id)}`,
    )
  ).json()) as {
    moka: {
      canvas: Array<{ nodes: unknown[] }>;
      resources: { images?: unknown[] };
    };
  };
  return {
    nodes: opened.moka.canvas[0]?.nodes.length ?? 0,
    images: opened.moka.resources.images?.length ?? 0,
  };
}

/**
 * One server, two windows, two projects, and no window moved off its own.
 *
 * A server answers about the project a request names, and a window names the
 * one it has open — so a second window opening a project of its own must not
 * take the first window's saves or its pictures with it. Before the windows
 * named their projects, this was the failure: whichever project was opened
 * most recently became the one every request was about, so the first window's
 * next save landed in the second window's document — or, with two fresh
 * projects at the same revision, was refused as a conflict.
 */
test("two windows on one server each keep their own project", async ({
  page,
  context,
}) => {
  const home = projectHome("two-windows");
  await forgetProjects();

  // The first window opens a project and gives it something of its own: a
  // picture only this project holds, carded onto its board.
  const first = page;
  const firstRoot = join(home, "first");
  await first.goto("/");
  await createProject(first, firstRoot, "First Window");
  await showAssets(first);
  await first.getByLabel("Import files", { exact: true }).setInputFiles({
    name: "only-here.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
  await expect(
    first.getByRole("button", { name: /^only-here\.png / }),
  ).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await viewOf(first, "first")).images).toBe(1);

  // The second window opens a project of its own, which is what makes it the
  // project the server opened most recently.
  const second = await context.newPage();
  const secondRoot = join(home, "second");
  await second.goto("/");
  await createProject(second, secondRoot, "Second Window");

  // The first window is still on its own project — its own name in the bar,
  // its own shelf — and its picture still loads: the address the picture is
  // fetched from names the project the window is about.
  await expect(
    first.getByRole("banner").locator(".editor-project-name"),
  ).toHaveText("First Window");
  const thumb = first.locator('[data-testid="resource-thumb"] img').first();
  await expect(thumb).toBeVisible();
  await expect
    .poll(() =>
      thumb.evaluate((node) => {
        const img = node as unknown as { naturalWidth: number };
        return img.naturalWidth;
      }),
    )
    .toBeGreaterThan(0);

  // An edit made now, with the second project the server's most recent, still
  // lands in the first project — and only there.
  await addNode(first, "Text");
  await expect
    .poll(async () => (await viewOf(first, "first")).nodes, { timeout: 15_000 })
    .toBe(2);
  expect((await viewOf(first, "first")).images).toBe(1);

  // The second window's project holds its own work and none of the first's:
  // it never saw the picture, and the first window's node did not land in it.
  await showAssets(second);
  await expect(
    second.getByRole("button", { name: /^only-here\.png / }),
  ).toHaveCount(0);
  expect(await viewOf(second, "second")).toEqual({ nodes: 0, images: 0 });

  // And the second window can work the same way: its edit is saved into its
  // own document without disturbing the first's.
  await addNode(second, "Text");
  await expect
    .poll(async () => (await viewOf(second, "second")).nodes, {
      timeout: 15_000,
    })
    .toBe(1);
  expect((await viewOf(first, "first")).nodes).toBe(2);

  forgetHome(home);
});
