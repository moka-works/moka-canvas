import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "./fixtures";
import {
  addNode,
  askToExport,
  createProject,
  exportWorkPackage,
  forgetHome,
  forgetProjects,
  projectHome,
} from "./helpers";

/**
 * Where an export lands, and what a second one does about the first.
 *
 * The save dialog opens at the project's own output folder, but the path it
 * takes is the reader's: a folder typed into it is where the file goes. And a
 * name the folder already holds is not written over quietly — the dialog says
 * so and the button changes what it will do before it is pressed.
 */
test("an export lands where the dialog says, and replacing is asked about", async ({
  page,
}) => {
  const home = projectHome("save-path");
  const root = join(home, "project");
  const elsewhere = join(home, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });

  await forgetProjects();
  await page.goto("/");
  await createProject(page, root, "Save Path");
  await addNode(page, "Text");
  await page.keyboard.press("Escape");

  // A file named by the reader, in a folder of their own rather than in the
  // project's output folder the dialog opened at.
  const destination = await exportWorkPackage(page, {
    folder: elsewhere,
    name: "hand-picked.zip",
  });
  expect(basename(destination)).toBe("hand-picked.zip");
  // Said first, since the write is the server's and lands a moment after the
  // dialog is answered; the file is read once the export has said so.
  await expect(page.getByText(destination).last()).toBeVisible({
    timeout: 10_000,
  });
  expect(existsSync(destination)).toBe(true);
  expect(statSync(destination).size).toBeGreaterThan(0);

  // The same name again: the dialog says the file is there and offers to
  // replace it rather than taking the same path silently.
  const asked = await askToExport(page);
  await asked.getByRole("button", { name: "Export package" }).click();
  const dialog = page.getByTestId("path-browser");
  await dialog.getByTestId("path-browser-typed").fill(elsewhere);
  await dialog.getByRole("button", { name: "List" }).click();
  await expect(dialog.getByTestId("path-browser-typed")).toHaveValue(
    new RegExp(`${basename(elsewhere)}$`),
    { timeout: 10_000 },
  );
  await dialog.getByTestId("path-browser-name").fill("hand-picked.zip");
  await expect(dialog.getByTestId("path-browser-overwrite")).toContainText(
    "hand-picked.zip",
  );
  const choose = dialog.getByTestId("path-browser-choose");
  await expect(choose).toHaveText("Replace");
  await choose.click();

  await expect(page.getByText(destination).last()).toBeVisible({
    timeout: 10_000,
  });
  expect(statSync(destination).size).toBeGreaterThan(0);

  forgetHome(home);
});

test("a save question backed out of writes nothing", async ({ page }) => {
  const home = projectHome("save-cancel");
  const root = join(home, "project");

  await forgetProjects();
  await page.goto("/");
  await createProject(page, root, "Save Cancel");

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("menuitem", { name: "Export project" }).click();
  const asked = page.getByRole("dialog", { name: "Export package" });
  await asked.getByRole("button", { name: "Export package" }).click();
  const dialog = page.getByTestId("path-browser");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // Nothing was written and nothing was said: the export never happened, and
  // the question before it still stands to be answered another way.
  expect(existsSync(join(root, "output", "Save Cancel.mokapkg.zip"))).toBe(
    false,
  );
  await expect(page.getByText(/Exported \d+ files to /)).toBeHidden();

  forgetHome(home);
});
