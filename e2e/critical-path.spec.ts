import { readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import {
  addNode,
  askToExport,
  backToLauncher,
  chooseSavePath,
  createProject,
  exportWorkPackage,
  forgetProjects,
  openRecent,
  persistedNodeCount,
  projectHome,
  showAssets,
} from "./helpers";

// A tiny valid PNG (1x1 transparent pixel) used for asset import.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test("launcher boots, project persists across reload, and export/import roundtrips", async ({
  page,
}) => {
  const home = projectHome("flow");
  const root = join(home, "project");
  const importedRoot = join(home, "imported");

  await forgetProjects();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Moka Canvas" }),
  ).toBeVisible();
  await expect(page.getByText("No projects yet")).toBeVisible();

  // Create a project and land in the editor.
  await createProject(page, root, "E2E Flow");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  // Add a text node via the quick-add menu.
  await addNode(page, "Text");
  const hint = page.getByTestId("canvas-host").locator(".editor-canvas-hint");
  await expect(hint).toHaveText("1 nodes · 0 edges");
  await expect(page.getByText("Added Text")).toBeVisible();
  await page.keyboard.press("Escape");
  // Autosave is debounced; wait for the server to hold the node before
  // reloading, otherwise the reload can beat the flush.
  await expect
    .poll(() => persistedNodeCount(page), { timeout: 10_000 })
    .toBe(1);

  // Reload: the recent list offers the project, and reopening keeps the node.
  await page.reload();
  await openRecent(page, "E2E Flow");
  await expect(
    page.getByRole("banner").getByText("E2E Flow", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(hint).toHaveText("1 nodes · 0 edges");

  // Import an image asset through the shelf, which is the assets face of the
  // column beside the canvas.
  await showAssets(page);
  const importInput = page.getByLabel("Import files", { exact: true });
  await importInput.setInputFiles({
    name: "tiny.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
  await expect(
    page.getByRole("button", { name: /^tiny\.png 70 B/ }),
  ).toBeVisible({ timeout: 10_000 });
  // The shelf adds a card for what it took in, so the canvas holds two — and
  // the package is asked for only once the server is holding both, rather than
  // packing a document that is behind what the screen shows.
  await expect
    .poll(() => persistedNodeCount(page), { timeout: 10_000 })
    .toBe(2);

  // Export a package. The save dialog opens at the project's own output
  // folder, which is where the package goes unless a reader says otherwise.
  const destination = await exportWorkPackage(page);
  // The listing answers with the directory resolved, which on a Mac is not the
  // path a temporary folder was handed out as.
  expect(destination).toBe(
    join(realpathSync(join(root, "output")), "E2E Flow.mokapkg.zip"),
  );
  await expect(page.getByText(/Exported \d+ files to /)).toBeVisible({
    timeout: 10_000,
  });
  expect(destination).toMatch(/\.mokapkg\.zip$/);

  // Back to the launcher, then import the package into a fresh directory.
  await backToLauncher(page);
  await page
    .getByRole("button", { name: "Import project", exact: true })
    .click();
  const dialog = page.locator(".dialog");
  await dialog.getByLabel("Folder").fill(importedRoot);
  await dialog.locator("input[type=file]").setInputFiles(destination as string);
  await dialog.getByRole("button", { name: "Import project package" }).click();
  await expect(
    page.getByRole("banner").getByText("E2E Flow", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  // Both cards came back: the one that was typed and the one the shelf put
  // there when it took the file in.
  await expect(hint).toHaveText("2 nodes · 0 edges");
  await expect(
    page.getByRole("button", { name: /^tiny\.png 70 B/ }),
  ).toBeVisible();
});

test("missing asset surfaces the self-check dialog and blocks export", async ({
  page,
}) => {
  const home = projectHome("missing");
  // The chosen folder starts empty, so the project stands in it directly.
  const root = join(home, "project");

  await page.goto("/");
  await createProject(page, join(home, "project"), "Missing Asset");

  await showAssets(page);
  const importInput = page.getByLabel("Import files", { exact: true });
  await importInput.setInputFiles({
    name: "tiny.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
  await expect(
    page.getByRole("button", { name: /^tiny\.png 70 B/ }),
  ).toBeVisible({ timeout: 10_000 });

  // Export now to learn the asset's stored path, then leave to the launcher.
  await exportWorkPackage(page);
  await expect(page.getByText(/Exported \d+ files to /)).toBeVisible({
    timeout: 10_000,
  });
  await backToLauncher(page);
  // Break the asset on disk, reopen: the self-check dialog must name it.
  const assetsDir = join(root, "assets", "images");
  for (const entry of readdirSync(assetsDir)) {
    rmSync(join(assetsDir, entry));
  }

  await openRecent(page, "Missing Asset");
  const dialog = page.locator(".dialog");
  await expect(
    dialog.getByRole("heading", { name: "Missing or changed assets" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    dialog.locator("li").filter({ hasText: "tiny.png" }).first(),
  ).toContainText("Missing · assets/images/");

  // Open anyway; export is blocked and offers the incomplete route.
  await dialog
    .getByRole("button", { name: "Open with missing assets" })
    .click();
  await expect(
    page.getByRole("banner").getByText("Missing Asset", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  // The import put the image onto a node as it arrived, so there is nothing
  // this project could leave out and the choice that would is not offered.
  const asked = await askToExport(page);
  await expect(
    asked.getByRole("checkbox", { name: /Only the assets a node points at/ }),
  ).toBeDisabled();
  await asked.getByRole("button", { name: "Export package" }).click();
  // The path is answered once, before anything is written — and the refusal
  // that offers to carry on anyway is the same export, at the same path.
  await chooseSavePath(page);
  const blocked = page.locator(".dialog");
  await expect(
    blocked.getByRole("heading", { name: "Assets are missing" }),
  ).toBeVisible();
  await blocked.getByRole("button", { name: "Export anyway" }).click();
  await expect(page.getByText("flagged incomplete")).toBeVisible({
    timeout: 10_000,
  });
});
