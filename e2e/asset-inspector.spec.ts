import { join } from "node:path";
import { expect, test, type Page } from "./fixtures";
import {
  createProject,
  forgetHome,
  forgetProjects,
  projectHome,
  showAssets,
} from "./helpers";

// A tiny valid PNG (1x1 transparent pixel), and a file of words to read.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const TEXT_BODY = "The words this file holds, read out of the file itself.";

/** Takes a file in, and waits for the shelf to hold a row for it. */
async function importFile(
  page: Page,
  name: string,
  body: Buffer,
  mime: string,
) {
  await page.getByLabel("Import files", { exact: true }).setInputFiles({
    name,
    mimeType: mime,
    buffer: body,
  });
  await expect(
    page.getByRole("button", {
      name: new RegExp(`^${name.replace(".", "\\.")} `),
    }),
  ).toBeVisible({ timeout: 10_000 });
}

/** The shelf row a file has, and the click on it that asks about the file. */
function rowOf(page: Page, name: string) {
  return page.locator(".resource-row", { hasText: name }).first();
}

test("a file clicked on the shelf is read in the column beside the canvas", async ({
  page,
}) => {
  const home = projectHome("asset-inspector");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), "Asset Inspector");
  await showAssets(page);

  // Taken in without a card being made for it, so what is on the board is not
  // what the reader asked about: the click is about the file.
  await page.locator(".side-add-nodes input").uncheck();
  await importFile(page, "still.png", TINY_PNG, "image/png");

  // The column beside the canvas is on another face; asking about a file turns
  // it to the face that answers rather than answering somewhere unseen.
  await page.getByTestId("right-tab-assistant").click();
  await expect(page.getByTestId("right-tab-inspector")).toHaveAttribute(
    "aria-selected",
    "false",
  );

  const row = rowOf(page, "still.png");
  await row.getByTestId("resource-main").click();

  await expect(page.getByTestId("right-tab-inspector")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const inspector = page.locator(".editor-inspector");
  await expect(inspector).toContainText("still.png");
  await expect(inspector).toContainText("image/png");
  await expect(inspector).toContainText("70 B");
  await expect(inspector).toContainText("assets/images/still-");
  await expect(inspector).toContainText("1×1");
  // What the file looks like is shown where it is being read.
  await expect(page.getByTestId("asset-preview-image")).toBeVisible();
  // The row says it is the one being read.
  await expect(row).toHaveClass(/is-inspected/);

  // No card on this board holds it, so the way to the cards is not offered:
  // an offer that could only answer "nothing here" is better left unsaid.
  const focus = row.getByRole("button", {
    name: /Focus the cards on this canvas/,
  });
  await expect(focus).toBeDisabled();
  await expect(focus).toHaveAttribute(
    "title",
    "No card on this canvas uses it",
  );
  await expect(
    page
      .locator(".inspector-asset")
      .getByRole("button", { name: "Focus cards" }),
  ).toBeDisabled();

  forgetHome(home);
});

test("the way to the cards is offered where this board holds one", async ({
  page,
}) => {
  const home = projectHome("asset-focus");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), "Asset Focus");
  await showAssets(page);

  // Taken in the way the shelf takes things in by default, which puts a card on
  // the board for it: now there is somewhere to go.
  await importFile(page, "still.png", TINY_PNG, "image/png");
  const row = rowOf(page, "still.png");
  await expect(row).toContainText("1 use");

  const focus = row.getByRole("button", {
    name: /Focus the cards on this canvas/,
  });
  await expect(focus).toBeEnabled();
  await expect(focus).toHaveAttribute(
    "title",
    "Select the 1 card on this canvas using it",
  );

  // Asking about the file first, so that going to the cards can be seen to be a
  // move away from it rather than the same thing twice.
  await row.getByTestId("resource-main").click();
  await expect(row).toHaveClass(/is-inspected/);
  await expect(page.locator(".inspector-asset-name")).toHaveText("still.png");

  await focus.click();

  // The cards are chosen on the board, and the column follows the reader there
  // instead of going on reading the file that was asked about a click ago.
  await expect(page.getByLabel("Node title")).toHaveValue("still.png");
  await expect(row).not.toHaveClass(/is-inspected/);
  await expect(page.locator(".inspector-asset")).toHaveCount(0);

  forgetHome(home);
});

test("a file of words is previewed out of the file itself", async ({
  page,
}) => {
  const home = projectHome("asset-text");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), "Asset Words");
  await showAssets(page);
  await page.locator(".side-add-nodes input").uncheck();

  await page.getByTestId("asset-kind-text").click();
  await importFile(page, "notes.txt", Buffer.from(TEXT_BODY), "text/plain");

  await rowOf(page, "notes.txt").getByTestId("resource-main").click();

  // The entry says what a file is about in a word or two; what is in it is read
  // out of the file, which is what a reader clicking a file of words wants.
  await expect(page.getByTestId("asset-text")).toHaveText(TEXT_BODY);
  const inspector = page.locator(".editor-inspector");
  await expect(inspector).toContainText("notes.txt");
  await expect(inspector).toContainText("text/plain");
  await expect(inspector).toContainText("Texts · Text");

  forgetHome(home);
});
