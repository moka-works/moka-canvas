import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import {
  addNode,
  chooseSavePath,
  createProject,
  forgetProjects,
  projectHome,
} from "./helpers";

test("the canvas saves as a PNG of everything it holds", async ({ page }) => {
  await forgetProjects();
  await page.goto("/");
  const root = join(projectHome("image-export"), "project");
  await createProject(page, root, "Image Export");

  await addNode(page, "Text");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("menuitem", { name: "Export as image" }).click();

  // The save dialog opens at the project's own output folder, under the name
  // the canvas already has; taking it writes the file there and nowhere else.
  const dialog = page.getByTestId("path-browser");
  await expect(dialog.getByTestId("path-browser-name")).toHaveValue(
    "Canvas 1.png",
  );
  const destination = await chooseSavePath(page);
  // The listing answers with the directory resolved, which on a Mac is not the
  // path a temporary folder was handed out as — so the folder is resolved here
  // too, and the two are compared as the same place.
  expect(destination).toBe(
    join(realpathSync(join(root, "output")), "Canvas 1.png"),
  );
  await expect(
    page.getByText(`Canvas image saved to ${destination}`),
  ).toBeVisible({ timeout: 10_000 });

  // What landed on the machine the server runs on, read back as a file: PNG
  // signature, then the size the file declares — a picture of the diagram
  // rather than a blank canvas, and at twice the card's own pixels. A blank
  // canvas of the same size compresses to a fraction of this.
  const bytes = readFileSync(destination);
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  expect(width).toBeGreaterThan(400);
  expect(height).toBeGreaterThan(200);
  expect(bytes.length).toBeGreaterThan(2000);
});

test("a save backed out of writes nothing", async ({ page }) => {
  await forgetProjects();
  await page.goto("/");
  const root = join(projectHome("image-cancel"), "project");
  await createProject(page, root, "Image Cancel");

  await addNode(page, "Text");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("menuitem", { name: "Export as image" }).click();
  const dialog = page.getByTestId("path-browser");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // Nothing was written under the name the dialog offered, and nothing was
  // said about a save that never happened.
  expect(() => readFileSync(join(root, "output", "Canvas 1.png"))).toThrow();
  await expect(page.getByText(/Canvas image saved/)).toBeHidden();
});
