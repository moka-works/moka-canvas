import { basename, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "./fixtures";
import {
  backToLauncher,
  createProject,
  forgetHome,
  forgetProjects,
  projectHome,
} from "./helpers";

/**
 * A project reached by looking for it rather than by knowing where it is.
 *
 * A browser has no file dialog to ask, so the one on screen is the
 * application's own, reading the server's listings: the folders of the machine
 * it runs on, walked one at a time, with a path still typeable for a reader who
 * does know where they mean.
 */
test("a project is opened through the file dialog the web runtime draws", async ({
  page,
}) => {
  const home = projectHome("browse");
  const root = join(home, "project");
  // The folder already holds a reader's own file, so the project goes into a
  // subfolder of its own — and the dialog asks before making one, which the
  // helper answers the way a reader would.
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "notes.txt"), "kept");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, root, "Browsed");
  await backToLauncher(page);

  await page.getByRole("button", { name: "Open project" }).click();
  const asked = page.locator(".dialog").filter({ hasText: "Open project" });
  await asked.getByTestId("browse-project").click();

  const browser = page.getByTestId("path-browser");
  await expect(browser).toBeVisible();
  // Opened at a real folder rather than at nothing: the listing answers with
  // where it settled, which is the reader's own home unless one was named.
  const bar = browser.getByTestId("path-browser-typed");
  await expect(bar).not.toHaveValue("");
  await expect(browser.getByRole("listitem").first()).toBeVisible();

  // A long way down is typed rather than clicked through folder by folder, and
  // the bar then reads the directory the listing settled on, resolved — which on
  // a Mac is not the path a temporary folder was handed out as. A dialog that
  // showed a path of its own invention would be one nobody could trust.
  await bar.fill(root);
  await browser.getByRole("button", { name: "List" }).click();
  await expect(bar).toHaveValue(new RegExp(`${basename(root)}$`));

  // The one folder in it is the project's, and walking into it lists what the
  // project is made of: its own document, since a project is asked for by
  // extension and that is the kind of file this dialog was told to show.
  const folders = browser.getByRole("listitem");
  await expect(folders).toHaveCount(1);
  await folders.first().click();
  await expect(bar).toHaveValue(/browsed$/);
  const document = browser.getByTestId("path-browser-row-canvas.moka");
  await expect(document).toBeVisible();

  // Picking the file is what the button then takes, and a project is opened
  // from either that or the folder it sits in.
  await document.click();
  await expect(browser.getByTestId("path-browser-choice")).toContainText(
    "canvas.moka",
  );
  await browser.getByTestId("path-browser-choose").click();

  // The dialog is gone, the field holds what was chosen, and the project opens.
  await expect(browser).toBeHidden();
  await expect(asked.getByLabel("Project folder or .moka file")).toHaveValue(
    /canvas\.moka$/,
  );
  await asked.getByRole("button", { name: "Open project" }).click();
  await expect(
    page.getByRole("banner").getByText("Browsed", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  forgetHome(home);
});
