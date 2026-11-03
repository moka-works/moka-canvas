import { join } from "node:path";
import { expect, test } from "./fixtures";
import {
  configureTextModel,
  configureTextModelWithoutKey,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openStoryRoom,
  projectHome,
} from "./helpers";
import { STORYTELLER } from "./mock-provider";

/**
 * A telling asked of a model that is configured and holds no key.
 *
 * What the reader sees is the whole point of the screen: the batch is refused,
 * and the refusal names the model and offers the place its key goes, rather
 * than reporting that something did not come back.
 */

test("a model with no key is named, and its key's place offered", async ({
  page,
}) => {
  const home = projectHome("story-key-missing");
  await forgetProjects();
  await configureTextModelWithoutKey(STORYTELLER);
  try {
    await page.goto("/");
    await createProject(page, join(home, "project"), "Story No Key");
    await openStoryRoom(page);
    await newStory(page, "Rain at Night");

    await page
      .getByTestId("story-idea-input")
      .fill("Eleven at night, and the last train stops where it should not.");
    await page.getByTestId("story-confirm-idea").click();
    await expect(page.getByTestId("story-step-body-outline")).toBeVisible();
    await page.getByTestId("story-outline-start").click();

    // The reason, in the words of the thing that knows it — and the model it
    // names, which is the half a reader cannot work out from the screen.
    const told = page.locator(".toast").last();
    await expect(told).toContainText("did not come back", { timeout: 30_000 });
    await expect(told).toContainText("has no stored API key");
    await expect(told).toContainText(STORYTELLER);

    // Asking the same question again would be answered the same way, so the
    // toast leads to Settings instead.
    const settings = told.getByRole("button", { name: "Open settings" });
    await expect(settings).toBeVisible();
    await settings.click();

    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("tab", { name: "Text" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  } finally {
    // One server answers the whole suite, so the model is handed its key back
    // before the specs that come after.
    await configureTextModel(STORYTELLER);
    forgetHome(home);
  }
});
