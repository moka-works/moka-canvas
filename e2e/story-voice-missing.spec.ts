import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  configureModels,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openStoryRoom,
  projectHome,
  setMachineVoice,
} from "./helpers";
import { SPEAKER, STORYTELLER } from "./mock-provider";

/**
 * A try-out asked of a speech model with no voice anywhere.
 *
 * The converter cannot make a sound without one, and the engine's own answer
 * names neither the missing setting nor where it lives. What the reader is
 * shown instead is the sentence that says what is missing, and a press that
 * lands on the card's own Tone field — the first link of the voice chain,
 * rather than a page of settings two steps away.
 */

test("a voiceless try-out leads to the voice field that answers it", async ({
  page,
}) => {
  const home = projectHome("story-voice-missing");
  await forgetProjects();
  // Words to bring a cast onto the step, and a speech model for the try-out to
  // be asked of. Its voice is then taken away again: a machine that has never
  // set one is the state no press on the story's own steps can reach.
  await configureModels([
    { id: STORYTELLER, capability: "text", alias: "Storyteller" },
    { id: SPEAKER, capability: "speech", alias: "Speaker" },
  ]);
  await setMachineVoice("");
  try {
    await page.goto("/");
    await createProject(page, join(home, "project"), "Story No Voice");
    await openStoryRoom(page);
    await newStory(page, "Rain at Night");

    await page
      .getByTestId("story-idea-input")
      .fill("Eleven at night, and the last train stops where it should not.");
    await page.getByTestId("story-idea-duration-3").click();
    await page.getByTestId("story-confirm-idea").click();
    await expect(page.getByTestId("story-step-body-outline")).toBeVisible();
    await page.getByTestId("story-outline-start").click();
    await expect(page.locator(".story-chapter")).toHaveCount(3, {
      timeout: 30_000,
    });
    await page.getByTestId("story-confirm-outline").click();
    await page.getByTestId("story-step-elements").click();
    await page.getByTestId("story-elements-recognise").click();
    await expect(page.locator(".story-element")).toHaveCount(4, {
      timeout: 30_000,
    });

    // The refusal, in the words of the thing that knows it, and answered
    // where it was raised: the press takes the reader to this card's Tone.
    await page.getByTestId("story-voice-Keeper-try").click();
    const told = page.locator(".toast").last();
    await expect(told).toContainText("has no voice yet", { timeout: 30_000 });

    const fill = told.getByRole("button", { name: "Fill in the voice" });
    await expect(fill).toBeVisible();
    await fill.click();
    await expect(page.getByTestId("story-voice-Keeper-tone")).toBeFocused();

    // And the repair is heard: a tone written in where the press landed, and
    // the same press answered with the sound.
    await page.getByTestId("story-voice-Keeper-tone").fill("alloy");
    await page.getByTestId("story-voice-Keeper-tone").press("Enter");
    await page.getByTestId("story-voice-Keeper-try").click();
    await expect(page.getByTestId("story-voice-Keeper-try-player")).toBeVisible(
      { timeout: 30_000 },
    );
  } finally {
    // One server answers the whole suite, so the machine is given its voice
    // back before the specs that come after.
    await setMachineVoice("alloy");
    forgetHome(home);
  }
});
