import { join } from "node:path";
import { expect, test } from "./fixtures";
import {
  backToLauncher,
  createProject,
  forgetHome,
  forgetProjects,
  openRecent,
  projectHome,
} from "./helpers";

/**
 * The project's own words, written from the settings dialog.
 *
 * What the form says lives in the document rather than in the page that typed
 * it, so the words are read back from the server: the name reaches the bar
 * behind the dialog, the card the launcher shows, and the file on disk, and
 * the description survives the project being put down and opened again.
 */
test("the project tab writes down what the project is called and what it is about", async ({
  page,
}) => {
  const home = projectHome("project-settings");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), "Working Title");

  // The written words, as the server has them.
  const persisted = () =>
    page.evaluate(async () => {
      const response = await fetch("/api/v1/projects/current");
      const body = (await response.json()) as {
        moka?: {
          metadata?: { name?: string; description?: string | null };
        };
      };
      return [
        body.moka?.metadata?.name ?? "",
        body.moka?.metadata?.description ?? "",
      ];
    });

  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  // The Project section stands first among the sections, while settings still
  // opens on the models: the tab is turned over by hand.
  const sections = dialog.getByRole("tablist", { name: "Settings sections" });
  await expect(sections.getByRole("tab").first()).toHaveText("Project");
  await sections.getByRole("tab", { name: "Project" }).click();

  const name = dialog.getByLabel("Name", { exact: true });
  const description = dialog.getByLabel("Description", { exact: true });
  await expect(name).toHaveValue("Working Title");

  // Leaving either field writes both of them down.
  await name.fill("Autumn campaign");
  await description.fill("A launch teaser");
  await description.blur();
  await expect.poll(persisted).toEqual(["Autumn campaign", "A launch teaser"]);
  await expect(name).toHaveValue("Autumn campaign");

  // A name has to say something: an emptied one is told so beside the field,
  // and the words the document already holds are left alone.
  await name.fill("   ");
  await name.blur();
  await expect(dialog.getByRole("alert")).toHaveText("A project needs a name");
  await expect.poll(persisted).toEqual(["Autumn campaign", "A launch teaser"]);

  // The bar behind the dialog wears the new name, and so does the card the
  // launcher shows once the project is put down — without reopening it.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("banner")).toContainText("Autumn campaign");
  await backToLauncher(page);
  await expect(page.locator("button.launcher-recent").first()).toContainText(
    "Autumn campaign",
  );

  // And the document keeps the words across a reopening.
  await openRecent(page, "Autumn campaign");
  await expect(page.getByRole("banner")).toContainText("Autumn campaign", {
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Settings" }).click();
  await dialog.locator("#settings-toptab-project").click();
  await expect(dialog.getByLabel("Description", { exact: true })).toHaveValue(
    "A launch teaser",
  );

  forgetHome(home);
});
