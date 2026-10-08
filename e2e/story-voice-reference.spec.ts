import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  configureModels,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openStoryRoom,
  projectHome,
} from "./helpers";
import {
  PAINTER,
  PROVIDER_ORIGIN,
  providerCalls,
  STORYTELLER,
} from "./mock-provider";

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDING = readFileSync(join(HERE, "fixtures", "voice.wav"));

/** The speech model this spec configures: one that copies a recording. */
const CLONER = "clone-speaker";

// The whole telling is walked in one test — three steps, a cast, a board, two
// runs of the batch — which needs longer than the suite's own budget.
test.describe.configure({ timeout: 90_000 });

/**
 * A telling read aloud by a voice copied from a recording, end to end.
 *
 * The batch is asked of a model that reads a voice from a recording while no
 * card names one: every line is refused, and the refusal says where the
 * recordings are picked and lands there. Two cards are then pointed at one
 * recording, two ways — one uploaded from this machine, one picked from what
 * the project already holds — and the batch is asked again: both lines come
 * home read, and what the provider was handed is the recording rather than the
 * machine voice that stands behind every voice-less line.
 */
test("a telling's lines are read in a voice copied from the cards' recordings", async ({
  page,
}) => {
  const home = projectHome("story-voice-reference");
  await forgetProjects();
  await configureModels([
    { id: PAINTER, capability: "image", alias: "Painter" },
    { id: STORYTELLER, capability: "text", alias: "Storyteller" },
    {
      id: CLONER,
      capability: "speech",
      alias: "Cloner",
      converter: "e2eCloneSpeech",
    },
  ]);
  // The stand-in's log carries across specs, and the spec before this one in
  // the run left a try-out in it; the batch below is read against an empty log.
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  try {
    await page.goto("/");
    await createProject(page, join(home, "project"), "Story Voice Reference");
    await openStoryRoom(page);
    await newStory(page, "Rain at Night");

    // Steps one and two: a premise, and the chapters it is told in.
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

    // Step three: the cast, no card naming a recording.
    await page.getByTestId("story-step-elements").click();
    await page.getByTestId("story-elements-recognise").click();
    await expect(page.locator(".story-element")).toHaveCount(4, {
      timeout: 30_000,
    });
    await page.getByTestId("story-elements-draw-all").click();
    await expect(page.getByTestId("story-elements-views-all")).toBeEnabled({
      timeout: 60_000,
    });
    await page.getByTestId("story-elements-views-all").click();
    await expect(
      page
        .getByTestId("story-element-character-Keeper")
        .getByTestId("story-slot-turnaround")
        .locator("img"),
    ).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("story-confirm-elements").click();
    await expect(page.getByTestId("story-step-storyboard")).toBeEnabled({
      timeout: 30_000,
    });
    await page.getByTestId("story-step-storyboard").click();
    const firstAct = page.getByTestId("story-act-0");
    await page.getByTestId("story-board-generate").click();
    await expect(firstAct.getByTestId("story-table")).toBeVisible({
      timeout: 30_000,
    });

    // The act says two lines, and the batch is asked with no recording on any
    // card: both come back refused — the model reads a voice from a recording
    // and there is none — and the refusal says where the recordings live and
    // steps back to the cards that take them.
    const speak = firstAct.getByTestId("story-act-voice-go-0");
    await expect(speak).toContainText("2");
    await speak.click();
    const told = page.locator(".toast").last();
    await expect(told).toContainText("still need a reference recording", {
      timeout: 30_000,
    });
    const pick = told.getByRole("button", { name: "Pick the recordings" });
    await expect(pick).toBeVisible();
    await pick.click();
    await expect(
      page.getByTestId("story-element-character-Keeper"),
    ).toBeVisible({ timeout: 10_000 });

    // Two cards, one recording, two ways of pointing at it: the keeper's comes
    // off this machine, and the traveller's picks what the project now holds.
    await page.getByTestId("story-voice-Keeper-reference-file").setInputFiles({
      name: "voice.wav",
      mimeType: "audio/wav",
      buffer: RECORDING,
    });
    await expect(
      page.getByTestId("story-voice-Keeper-reference"),
    ).toContainText("voice.wav", { timeout: 20_000 });
    await page.getByTestId("story-voice-Traveller-reference-open").click();
    await page
      .getByTestId("story-voice-Traveller-reference-choice-voice.wav")
      .click();
    await expect(
      page.getByTestId("story-voice-Traveller-reference"),
    ).toContainText("voice.wav");

    // Back to the board, and the batch asked again: both lines are read, and
    // every ask carried the recording — the file, where the converter sends a
    // reference, and never the machine voice that stands behind a nameless
    // card, which is what a voice-less ask would have sent.
    await expect(page.getByTestId("story-step-storyboard")).toBeEnabled({
      timeout: 10_000,
    });
    await page.getByTestId("story-step-storyboard").click();
    await expect(firstAct.getByTestId("story-table")).toBeVisible({
      timeout: 10_000,
    });
    await firstAct.getByTestId("story-act-voice-go-0").click();
    await expect(firstAct.getByTestId("story-act-voice-count-0")).toBeVisible({
      timeout: 60_000,
    });
    await expect(firstAct.getByTestId("story-act-voice-go-0")).toHaveCount(0);

    const spoken = (await providerCalls()).filter(
      (call) => call.path === "/v1/audio/speech",
    );
    expect(spoken).toHaveLength(2);
    for (const call of spoken) {
      expect(call.model).toBe(CLONER);
      expect(call.voice, "the recording travelled, and not the name").toBe(
        "ref:voice.wav",
      );
    }
  } finally {
    forgetHome(home);
  }
});
